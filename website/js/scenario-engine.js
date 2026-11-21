/*! FIELD//ZERO what-if scenario engine v0.1.1
 *
 *  WHAT-IF COMPARISONS UNDER THE SAME ASSUMED ROVER MODEL. NOT FORECASTS.
 *
 *  Applies explicit, named changes to (a copy of) the plan and rover, re-runs the route simulation, and compares each
 *  scenario with the baseline: mission progress, objectives, resources, risk index, cost and outcome. Every change is
 *  also run ALONE (one-at-a-time attribution) so the effect of each change is explained, plus the interaction residual.
 *  Inputs are never mutated. Deterministic: same inputs => identical output.
 *
 *  ======================================================================================
 *  INPUT   run({ plan, rover, scenarios, options?, deps?, assumptions?, attribution?=true })
 *    plan, rover   as for FieldZeroSim (FZ-PLAN-PROVISIONAL-0.1). Baseline = exactly these.
 *    scenarios     [ { id, name?, description?, changes } ]
 *    changes = {
 *      resources:       { battery_capacity_scale, battery_capacity_wh, initial_soc_frac, solar_input_w, reserve_frac },
 *      duration:        { max_mission_s, max_mission_scale },
 *      rover_condition: { mobility, power_draw_factor, battery_health, slope_limit_factor },
 *      route_conditions:{ slope_offset_deg, slope_scale, roughness_scale, length_scale, traction_speed_factor,
 *                         blocked_segments: [segment id | index], max_slope_deg, max_roughness_std }
 *    }
 *    Unknown keys or invalid values are NOT applied; they are listed in `ignored` with the reason.
 *    options  { onViolation?: 'halt'|'record_and_continue', evaluateRecovery?: false (default false for speed), costRates? }
 *  OUTPUT  "FZ-SCENARIOS-0.1"
 *    { baseline: summary, scenarios: [ { id, name, changes_applied[], ignored[], summary, delta_vs_baseline, outcome_change,
 *      explanation[], attribution{ per_change[], interaction_progress_pts }, failure{...}|null } ], ranking[], notes[] }
 *  Also: sweep({plan, rover, path, values}) -> table + first value at which the outcome class changes.
 *
 *  METRICS (all 'simulated' under the assumed model)
 *    mission_class: SUCCESS = all required objectives done and route finished; PARTIAL = some required done; FAILED = none.
 *    progress_fraction = planned distance covered / planned distance.   risk_index: see failure-analysis.js (heuristic 0-100).
 *    delta = scenario - baseline;  pct = 100*delta/baseline (null when baseline is 0).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.FieldZeroScenario = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function (root) {
  'use strict';

  var VERSION = '0.1.1', CONTRACT = 'FZ-SCENARIOS-0.1';
  var SUPPORTED = {
    resources: ['battery_capacity_scale', 'battery_capacity_wh', 'initial_soc_frac', 'solar_input_w', 'reserve_frac'],
    duration: ['max_mission_s', 'max_mission_scale'],
    rover_condition: ['mobility', 'power_draw_factor', 'battery_health', 'slope_limit_factor'],
    route_conditions: ['slope_offset_deg', 'slope_scale', 'roughness_scale', 'length_scale', 'traction_speed_factor', 'blocked_segments', 'max_slope_deg', 'max_roughness_std']
  };
  var LIMITATIONS = [
    'Scenarios are what-if runs of the same assumed model; they show direction and rough size of effects, not forecasts.',
    'Route-condition changes only modify values already present in the plan; unknown (missing) terrain values stay unknown and are not altered.',
    'Attribution runs each change alone; interaction is reported as a residual and is not decomposed further.',
    'The risk index is a heuristic combining margins (see failure-analysis.js), not a probability.'
  ];
  var CLASS_RANK = { SUCCESS: 0, PARTIAL: 1, FAILED: 2 };

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function rd(v, d) { if (!isNum(v)) return v; var k = Math.pow(10, d == null ? 3 : d); return Math.round(v * k) / k; }
  function dep(ctx, key, g, file) {
    if (ctx && ctx.deps && ctx.deps[key]) return ctx.deps[key];
    if (root && root[g]) return root[g];
    if (typeof require === 'function') { try { return require(file); } catch (e) { /* optional */ } }
    return null;
  }
  function pct(b, s) { return (isNum(b) && b !== 0 && isNum(s)) ? rd(100 * (s - b) / Math.abs(b), 2) : null; }
  function delta(b, s, d) { return { baseline: isNum(b) ? rd(b, d == null ? 4 : d) : b, scenario: isNum(s) ? rd(s, d == null ? 4 : d) : s, delta: (isNum(b) && isNum(s)) ? rd(s - b, d == null ? 4 : d) : null, pct: pct(b, s) }; }

  // ------------------------------------------------------------------ change application
  function flatten(changes) {
    var atoms = [], ignored = [];
    if (changes != null && (typeof changes !== 'object' || Array.isArray(changes))) return { atoms: atoms, ignored: [{ path: 'changes', reason: 'changes must be an object keyed by change group' }] };
    Object.keys(changes || {}).forEach(function (g) {
      if (changes[g] != null && (typeof changes[g] !== 'object' || Array.isArray(changes[g]))) { ignored.push({ path: g, reason: 'change group must be an object of key/value pairs' }); return; }
      if (!SUPPORTED[g]) { ignored.push({ path: g, reason: 'unknown change group (supported: ' + Object.keys(SUPPORTED).join(', ') + ')' }); return; }
      Object.keys(changes[g] || {}).forEach(function (k) {
        if (SUPPORTED[g].indexOf(k) === -1) ignored.push({ path: g + '.' + k, reason: 'unsupported key (supported: ' + SUPPORTED[g].join(', ') + ')' });
        else atoms.push({ group: g, key: k, path: g + '.' + k, value: changes[g][k] });
      });
    });
    return { atoms: atoms, ignored: ignored };
  }
  function atomsToChanges(atoms) { var c = {}; atoms.forEach(function (a) { (c[a.group] = c[a.group] || {})[a.key] = a.value; }); return c; }

  function segLength(plan, i) {
    var g = (plan.segments || [])[i] || {};
    if (isNum(g.length_m)) return g.length_m;
    if (Array.isArray(g.path) && g.path.length >= 2) { var s = 0; for (var k = 1; k < g.path.length; k++) s += Math.hypot(g.path[k].x_m - g.path[k - 1].x_m, g.path[k].y_m - g.path[k - 1].y_m); return s; }
    var a = plan.waypoints[i], b = plan.waypoints[i + 1];
    return (a && b && isNum(a.x_m) && isNum(b.x_m)) ? Math.hypot(a.x_m - b.x_m, a.y_m - b.y_m) : null;
  }

  /** Returns { plan, rover, applied[], ignored[] } (deep copies). */
  function applyChanges(plan, rover, changes, Sim) {
    var p = clone(plan), r = clone(rover) || {}, fl = flatten(changes), applied = [], ignored = fl.ignored.slice();
    var nr = Sim.normalizeRover(r).rover;                       // resolved baseline values for from/to reporting
    r.condition = clone(nr.condition);
    p.constraints = p.constraints || {}; p.environment = p.environment || {}; p.segments = p.segments || [];
    var nSeg = Math.max(0, (p.waypoints || []).length - 1);
    while (p.segments.length < nSeg) p.segments.push({});
    var ok = function (a, from, to, text) { applied.push({ path: a.path, from: from, to: to, description: text }); };
    var bad = function (a, why) { ignored.push({ path: a.path, value: a.value, reason: why }); };
    fl.atoms.forEach(function (a) {
      var v = a.value, k = a.key;
      if (a.group === 'resources') {
        if (k === 'battery_capacity_scale') { if (!(isNum(v) && v > 0)) return bad(a, 'must be > 0'); var from = nr.battery_capacity_wh; r.battery_capacity_wh = from * v; ok(a, from, r.battery_capacity_wh, 'Battery nameplate capacity x' + v + ': ' + rd(from, 1) + ' -> ' + rd(r.battery_capacity_wh, 1) + ' Wh.'); }
        else if (k === 'battery_capacity_wh') { if (!(isNum(v) && v > 0)) return bad(a, 'must be > 0'); ok(a, nr.battery_capacity_wh, v, 'Battery nameplate capacity ' + rd(nr.battery_capacity_wh, 1) + ' -> ' + v + ' Wh.'); r.battery_capacity_wh = v; }
        else if (k === 'initial_soc_frac') { if (!(isNum(v) && v >= 0 && v <= 1)) return bad(a, 'must be within [0,1]'); ok(a, nr.initial_soc_frac, v, 'Initial state of charge ' + rd(nr.initial_soc_frac * 100, 1) + '% -> ' + rd(v * 100, 1) + '%.'); r.initial_soc_frac = v; }
        else if (k === 'solar_input_w') { if (!(isNum(v) && v >= 0)) return bad(a, 'must be >= 0'); var f0 = (plan.environment && plan.environment.solar_input_w) || 0; ok(a, f0, v, 'Constant charging power ' + f0 + ' -> ' + v + ' W (assumed constant; no day/night model).'); p.environment.solar_input_w = v; }
        else if (k === 'reserve_frac') { if (!(isNum(v) && v >= 0 && v < 1)) return bad(a, 'must be within [0,1)'); var cminR = p.constraints && isNum(p.constraints.min_battery_soc_frac) ? p.constraints.min_battery_soc_frac : null; if (cminR != null && v <= cminR) return bad(a, 'has no effect: plan.constraints.min_battery_soc_frac = ' + cminR + ' is at least as strict and still governs the reserve'); ok(a, nr.min_soc_frac, v, 'Battery reserve ' + rd(nr.min_soc_frac * 100, 1) + '% -> ' + rd(v * 100, 1) + '% of usable capacity.'); r.min_soc_frac = v; }
      } else if (a.group === 'duration') {
        var cur = isNum(p.constraints.max_mission_s) ? p.constraints.max_mission_s : null;
        if (k === 'max_mission_s') { if (!(isNum(v) && v > 0)) return bad(a, 'must be > 0'); ok(a, cur, v, 'Mission time limit ' + (cur == null ? 'none' : rd(cur, 0) + ' s') + ' -> ' + rd(v, 0) + ' s.'); p.constraints.max_mission_s = v; }
        else { if (!(isNum(v) && v > 0)) return bad(a, 'must be > 0'); if (cur == null) return bad(a, 'baseline has no max_mission_s to scale; use duration.max_mission_s'); ok(a, cur, cur * v, 'Mission time limit x' + v + ': ' + rd(cur, 0) + ' -> ' + rd(cur * v, 0) + ' s.'); p.constraints.max_mission_s = cur * v; }
      } else if (a.group === 'rover_condition') {
        var lim = { mobility: [0, 1, true], power_draw_factor: [0, Infinity, false], battery_health: [0, 1, false], slope_limit_factor: [0, 1, false] }[k];
        if (!(isNum(v) && v >= lim[0] && v <= lim[1] && (lim[2] || v > lim[0]))) return bad(a, 'out of range (' + (lim[2] ? '[' : '(') + lim[0] + ', ' + (lim[1] === Infinity ? 'inf' : lim[1]) + '])');
        var cf = nr.condition[k], txt = { mobility: 'Mobility factor: speed scales by the factor, so driving time rises by 1/factor.', power_draw_factor: 'All electrical loads scale by this factor.', battery_health: 'Usable capacity = nameplate x health: ' + rd(nr.battery_capacity_wh * cf, 1) + ' -> ' + rd((isNum(r.battery_capacity_wh) ? r.battery_capacity_wh : nr.battery_capacity_wh) * v, 1) + ' Wh.', slope_limit_factor: 'Effective rover slope limit ' + rd(nr.max_slope_deg * cf, 2) + ' -> ' + rd(nr.max_slope_deg * v, 2) + ' deg.' }[k];
        ok(a, cf, v, 'Rover condition ' + k + ' ' + cf + ' -> ' + v + '. ' + txt); r.condition[k] = v;
      } else if (a.group === 'route_conditions') {
        var segs = p.segments;
        if (k === 'slope_offset_deg' || k === 'slope_scale') {
          if (!isNum(v) || (k === 'slope_scale' && v < 0)) return bad(a, 'invalid number');
          var n = 0, unk = 0; segs.forEach(function (g) { if (isNum(g.slope_deg)) { n++; g.slope_deg = Math.max(0, k === 'slope_scale' ? g.slope_deg * v : g.slope_deg + v); if (isNum(g.slope_deg_max)) g.slope_deg_max = Math.max(0, k === 'slope_scale' ? g.slope_deg_max * v : g.slope_deg_max + v); } else unk++; });
          if (!n) return bad(a, 'no segment carries slope data to modify');
          ok(a, null, v, 'Slope ' + (k === 'slope_scale' ? 'x' + v : (v >= 0 ? '+' : '') + v + ' deg') + ' on ' + n + ' segment(s)' + (unk ? '; ' + unk + ' segment(s) with unknown slope are left unknown' : '') + '.');
        } else if (k === 'roughness_scale') {
          if (!(isNum(v) && v >= 0)) return bad(a, 'must be >= 0');
          var m = 0; segs.forEach(function (g) { if (isNum(g.roughness_std)) { m++; g.roughness_std *= v; if (isNum(g.roughness_std_max)) g.roughness_std_max *= v; } });
          if (!m) return bad(a, 'no segment carries roughness data to modify'); ok(a, null, v, 'Roughness x' + v + ' on ' + m + ' segment(s).');
        } else if (k === 'length_scale') {
          if (!(isNum(v) && v > 0)) return bad(a, 'must be > 0');
          var cnt = 0, lens = segs.map(function (g, i) { return segLength(p, i); });
          if (lens.some(function (l) { return l == null; })) return bad(a, 'some segment lengths cannot be derived from the plan');
          segs.forEach(function (g, i) { g.length_m = lens[i] * v; cnt++; }); ok(a, null, v, 'Segment lengths x' + v + ' on ' + cnt + ' segment(s) (e.g. detours or path inflation).');
        } else if (k === 'traction_speed_factor') {
          if (!(isNum(v) && v > 0 && v <= 1)) return bad(a, 'must be within (0,1]');
          segs.forEach(function (g) { g.traction_speed_factor = Math.min(1, (isNum(g.traction_speed_factor) ? g.traction_speed_factor : 1) * v); }); ok(a, 1, v, 'Surface traction: speed x' + v + ' on all segments.');
        } else if (k === 'blocked_segments') {
          if (!Array.isArray(v) || !v.length) return bad(a, 'must be a non-empty array of segment ids or indices');
          var hit = [], miss = [];
          v.forEach(function (ref) { var idx = -1; segs.forEach(function (g, i) { var id = g.id != null ? String(g.id) : p.waypoints[i].id + '>' + p.waypoints[i + 1].id; if (id === String(ref) || i === ref) idx = i; });
            if (idx < 0) miss.push(ref); else { segs[idx].passable = false; hit.push(idx); } });
          if (!hit.length) return bad(a, 'no matching segment for ' + JSON.stringify(v));
          ok(a, null, hit, 'Segment(s) ' + hit.join(', ') + ' marked blocked' + (miss.length ? '; unmatched refs ignored: ' + JSON.stringify(miss) : '') + '.');
        } else if (k === 'max_slope_deg' || k === 'max_roughness_std') {
          if (!(isNum(v) && v > 0)) return bad(a, 'must be > 0'); var cc = p.constraints[k] != null ? p.constraints[k] : null;
          ok(a, cc, v, 'Planning constraint ' + k + ' ' + (cc == null ? 'none' : cc) + ' -> ' + v + '.'); p.constraints[k] = v;
        }
      }
    });
    return { plan: p, rover: r, applied: applied, ignored: ignored };
  }

  // ------------------------------------------------------------------ run + summarise
  function summarise(report, fail, cost, Fail) {
    var os = report.objective_summary, E = report.totals.energy;
    var cls = Fail ? Fail.classify(os.required_completed, os.required_total, report.status === 'completed') : (os.required_total === 0 ? (report.status === 'completed' ? 'SUCCESS' : 'FAILED') : (os.required_completed === os.required_total && report.status === 'completed' ? 'SUCCESS' : os.required_completed > 0 ? 'PARTIAL' : 'FAILED'));
    var risk = fail && fail.margins ? fail.margins.risk_index : null;
    return { status: report.status, halted_code: report.halted ? report.halted.code : null, mission_class: cls, required_completed: os.required_completed, required_total: os.required_total, objectives_completed: os.completed, objectives_total: os.total,
      progress_fraction: report.totals.progress_fraction, distance_m: report.totals.distance_in_plan_m, elapsed_s: report.totals.elapsed_s, energy_consumed_wh: E.consumed_wh.total, final_energy_wh: E.end_wh, min_energy_wh: E.min_wh,
      usable_capacity_wh: E.usable_capacity_wh, reserve_wh: E.reserve_wh, risk_index: risk, cost_simulated_total: cost && cost.status === 'ok' ? cost.cost.simulated.total : null, failure_count: fail && fail.failures ? fail.failures.length : null,
      primary_failure_code: fail && fail.summary ? fail.summary.mission_stopping_failure : null, provenance: 'simulated (assumed model)' };
  }
  function runOne(plan, rover, ctx, evalRecovery) {
    var Sim = ctx.Sim, rep = Sim.run(plan, { rover: rover, onViolation: ctx.options.onViolation || 'halt', traceEveryS: 1e12 });
    if (rep.validation.errors.length) return { report: rep, invalid: rep.validation.errors };
    var fail = ctx.Fail ? ctx.Fail.analyze(rep, { plan: plan, rover: rover, deps: { simulation: Sim }, evaluateRecovery: evalRecovery }) : null;
    var cost = ctx.Cost ? ctx.Cost.compute({ report: rep, plan: plan, rover: rover, deps: { simulation: Sim }, assumptions: ctx.assumptions }) : null;
    return { report: rep, fail: fail, cost: cost, summary: summarise(rep, fail, cost, ctx.Fail) };
  }

  var DELTA_FIELDS = [['progress_fraction', 4], ['distance_m', 1], ['elapsed_s', 1], ['energy_consumed_wh', 2], ['final_energy_wh', 2], ['min_energy_wh', 2], ['risk_index', 1], ['cost_simulated_total', 2], ['required_completed', 0], ['objectives_completed', 0]];
  function deltas(b, s) { var o = {}; DELTA_FIELDS.forEach(function (f) { o[f[0]] = delta(b[f[0]], s[f[0]], f[1]); }); return o; }

  function explain(b, s, fail, applied, baseRun, scenRun) {
    var out = [];
    applied.forEach(function (a) { out.push('Change: ' + a.description); });
    if (b.mission_class !== s.mission_class) out.push('Outcome: ' + b.mission_class + ' -> ' + s.mission_class + '.');
    else out.push('Outcome class unchanged (' + s.mission_class + ').');
    var dp = (s.progress_fraction - b.progress_fraction) * 100;
    out.push('Mission progress: ' + rd(b.progress_fraction * 100, 1) + '% -> ' + rd(s.progress_fraction * 100, 1) + '% of the planned distance (' + (dp >= 0 ? '+' : '') + rd(dp, 1) + ' pts); required objectives ' + b.required_completed + '/' + b.required_total + ' -> ' + s.required_completed + '/' + s.required_total + '.');
    var de = s.energy_consumed_wh - b.energy_consumed_wh;
    out.push('Resources: energy consumed ' + rd(b.energy_consumed_wh, 1) + ' -> ' + rd(s.energy_consumed_wh, 1) + ' Wh (' + (de >= 0 ? '+' : '') + rd(de, 1) + '); usable capacity ' + rd(b.usable_capacity_wh, 1) + ' -> ' + rd(s.usable_capacity_wh, 1) + ' Wh; lowest battery level ' + rd(b.min_energy_wh, 1) + ' -> ' + rd(s.min_energy_wh, 1) + ' Wh (reserve ' + rd(s.reserve_wh, 1) + ' Wh); elapsed time ' + rd(b.elapsed_s / 3600, 2) + ' -> ' + rd(s.elapsed_s / 3600, 2) + ' h.');
    if (b.risk_index != null && s.risk_index != null) out.push('Risk (heuristic index 0-100): ' + b.risk_index + ' -> ' + s.risk_index + (s.risk_index > b.risk_index ? ' (higher)' : s.risk_index < b.risk_index ? ' (lower)' : ' (same)') + '.');
    if (b.cost_simulated_total != null && s.cost_simulated_total != null) out.push('Cost (simulated, placeholder rates): ' + rd(b.cost_simulated_total, 1) + ' -> ' + rd(s.cost_simulated_total, 1) + ' CU.');
    if (fail && fail.failures && fail.failures.length && s.primary_failure_code && s.primary_failure_code !== b.primary_failure_code) {
      var f = fail.failures.filter(function (x) { return x.code === s.primary_failure_code; })[0];
      if (f) { out.push('New failure ' + f.code + ': ' + f.causes.summary); if (f.recovery && f.recovery.evaluated) out.push('Recovery: ' + f.recovery.explanation); }
    } else if (!s.primary_failure_code && b.primary_failure_code) out.push('The baseline failure (' + b.primary_failure_code + ') does not occur in this scenario.');
    return out;
  }

  function run(input) {
    input = input || {};
    var Sim = dep(input, 'simulation', 'FieldZeroSim', './route-simulation.js');
    if (!Sim) return { contract: CONTRACT, version: VERSION, status: 'error', error: 'route-simulation module (FieldZeroSim) is required.' };
    var ctx = { Sim: Sim, Fail: dep(input, 'failure', 'FieldZeroFailure', './failure-analysis.js'), Cost: dep(input, 'cost', 'FieldZeroCost', './cost-engine.js'), options: input.options || {}, assumptions: input.assumptions };
    var plan = input.plan, rover = input.rover || {}, notes = [];
    if (input.scenarios !== undefined && input.scenarios !== null && !Array.isArray(input.scenarios)) return { contract: CONTRACT, version: VERSION, status: 'error', error: 'scenarios must be an array of { id, name?, changes } objects.' };
    if (!ctx.Fail) notes.push('failure-analysis module not available: risk index, failure causes and recovery are omitted.');
    if (!ctx.Cost) notes.push('cost-engine module not available: cost deltas are omitted.');
    var base = runOne(plan, rover, ctx, ctx.options.evaluateRecovery === true);
    if (base.invalid) return { contract: CONTRACT, version: VERSION, status: 'invalid_baseline', error: 'Baseline plan/rover invalid: ' + base.invalid.join('; '), notes: notes };
    var attribution = input.attribution !== false, res = [];
    var seenIds = {};
    (input.scenarios || []).forEach(function (sc, i) {
      if (!sc || typeof sc !== 'object' || Array.isArray(sc)) { res.push({ id: 'S' + (i + 1), name: 'S' + (i + 1), status: 'invalid_scenario', changes_applied: [], ignored: [], explanation: ['scenarios[' + i + '] must be an object { id, name?, changes }; it was skipped.'] }); return; }
      var id = sc.id != null ? String(sc.id) : 'S' + (i + 1);
      if (seenIds[id]) { res.push({ id: id, name: sc.name || id, status: 'invalid_scenario', changes_applied: [], ignored: [], explanation: ['Duplicate scenario id "' + id + '" (scenarios[' + i + ']); skipped so results stay unambiguous.'] }); return; }
      seenIds[id] = true;
      var ap = applyChanges(plan, rover, sc.changes || {}, Sim);
      if (!ap.applied.length) { res.push({ id: id, name: sc.name || id, description: sc.description || '', status: 'no_changes_applied', changes_applied: [], ignored: ap.ignored, explanation: ['No valid change was applied; nothing to compare.'] }); return; }
      var run1 = runOne(ap.plan, ap.rover, ctx, ctx.options.evaluateRecovery !== false);
      if (run1.invalid) { res.push({ id: id, name: sc.name || id, status: 'invalid_scenario', changes_applied: ap.applied, ignored: ap.ignored, explanation: ['The changed inputs are invalid: ' + run1.invalid.join('; ')] }); return; }
      var out = { id: id, name: sc.name || id, description: sc.description || '', status: 'ok', changes_applied: ap.applied, ignored: ap.ignored, summary: run1.summary, delta_vs_baseline: deltas(base.summary, run1.summary),
        outcome_change: { baseline: base.summary.mission_class, scenario: run1.summary.mission_class, changed: base.summary.mission_class !== run1.summary.mission_class },
        explanation: explain(base.summary, run1.summary, run1.fail, ap.applied, base, run1),
        failure: run1.fail ? { status: run1.fail.status, summary: run1.fail.summary, failures: run1.fail.failures.map(function (f) { return { id: f.id, code: f.code, severity: f.severity, cause_summary: f.causes.summary, primary_cause: f.causes.primary, recovery_feasibility: f.recovery.feasibility, best_recovery_action_id: f.recovery.best_action_id, mission_impact: f.mission_impact }; }) } : null,
        report: input.includeReports ? run1.report : undefined };
      if (attribution) {
        var atoms = flatten(sc.changes).atoms, per = [], sumDp = 0;
        atoms.forEach(function (a) {
          var one = applyChanges(plan, rover, atomsToChanges([a]), Sim);
          if (!one.applied.length) { per.push({ path: a.path, value: a.value, applied: false, reason: (one.ignored[0] && one.ignored[0].reason) || 'not applied' }); return; }
          var r1 = runOne(one.plan, one.rover, ctx, false), dp = (r1.summary.progress_fraction - base.summary.progress_fraction) * 100; sumDp += dp;
          per.push({ path: a.path, value: a.value, applied: true, description: one.applied[0].description, mission_class: r1.summary.mission_class, status: r1.summary.status, halted_code: r1.summary.halted_code,
            progress_pts_vs_baseline: rd(dp, 2), required_completed_delta: r1.summary.required_completed - base.summary.required_completed, risk_index_delta: (r1.summary.risk_index != null && base.summary.risk_index != null) ? rd(r1.summary.risk_index - base.summary.risk_index, 1) : null,
            energy_consumed_delta_wh: rd(r1.summary.energy_consumed_wh - base.summary.energy_consumed_wh, 2), cost_delta: (r1.summary.cost_simulated_total != null && base.summary.cost_simulated_total != null) ? rd(r1.summary.cost_simulated_total - base.summary.cost_simulated_total, 2) : null });
        });
        var totalDp = (run1.summary.progress_fraction - base.summary.progress_fraction) * 100;
        out.attribution = { method: 'one-at-a-time: each change applied alone to the baseline', per_change: per, combined_progress_pts: rd(totalDp, 2), sum_of_individual_progress_pts: rd(sumDp, 2), interaction_progress_pts: rd(totalDp - sumDp, 2),
          note: Math.abs(totalDp - sumDp) < 0.05 ? 'Changes act independently on progress (no meaningful interaction).' : 'Changes interact: the combined effect differs from the sum of the individual effects.' };
        var worst = per.filter(function (x) { return x.applied; }).sort(function (a, b) { return a.progress_pts_vs_baseline - b.progress_pts_vs_baseline; })[0];
        if (worst && per.length > 1) out.explanation.push('Largest single driver of lost progress: ' + worst.path + ' (' + worst.progress_pts_vs_baseline + ' pts on its own).');
      }
      res.push(out);
    });
    var ranking = res.filter(function (r) { return r.status === 'ok'; }).concat([{ id: 'BASELINE', name: 'Baseline', summary: base.summary, status: 'ok' }]).sort(function (a, b) {
      return CLASS_RANK[a.summary.mission_class] - CLASS_RANK[b.summary.mission_class] || b.summary.progress_fraction - a.summary.progress_fraction || (a.summary.risk_index || 0) - (b.summary.risk_index || 0) || (a.id < b.id ? -1 : 1);
    }).map(function (r, i) { return { rank: i + 1, id: r.id, name: r.name, mission_class: r.summary.mission_class, progress_fraction: r.summary.progress_fraction, risk_index: r.summary.risk_index }; });
    return { contract: CONTRACT, version: VERSION, status: 'ok', baseline: base.summary, baseline_failure: base.fail ? base.fail.summary : null, scenarios: res, ranking: ranking, ranking_rule: 'mission class, then progress (desc), then risk index (asc), then id',
      supported_changes: clone(SUPPORTED), notes: notes, limitations: LIMITATIONS.slice(), assumptions: Sim.ASSUMPTIONS ? Sim.ASSUMPTIONS.slice() : [] };
  }

  /** Parameter sweep, e.g. path 'resources.battery_capacity_scale', values [0.5,0.6,...]. */
  function sweep(input) {
    input = input || {};
    var parts = String(input.path || '').split('.'), g = parts[0], k = parts[1];
    if (!Array.isArray(input.values) || !input.values.length || input.values.length > 200) return { contract: CONTRACT, status: 'error', error: 'values must be a non-empty array (max 200 entries).' };
    if (!SUPPORTED[g] || SUPPORTED[g].indexOf(k) === -1) return { contract: CONTRACT, status: 'error', error: 'unsupported path "' + input.path + '"' };
    var scs = (input.values || []).map(function (v, i) { var ch = {}; ch[g] = {}; ch[g][k] = v; return { id: 'v' + i, name: input.path + ' = ' + v, changes: ch }; });
    var r = run({ plan: input.plan, rover: input.rover, scenarios: scs, attribution: false, deps: input.deps, options: { evaluateRecovery: false }, assumptions: input.assumptions });
    if (r.status !== 'ok') return r;
    var rows = r.scenarios.map(function (s, i) { return { value: input.values[i], status: s.status, reason: s.status === 'ok' ? null : ((s.ignored && s.ignored[0] && s.ignored[0].reason) || (s.explanation && s.explanation[0]) || null), mission_class: s.summary && s.summary.mission_class, halted_code: s.summary && s.summary.halted_code, progress_fraction: s.summary && s.summary.progress_fraction, required_completed: s.summary && s.summary.required_completed, risk_index: s.summary && s.summary.risk_index, min_energy_wh: s.summary && s.summary.min_energy_wh }; });
    var flip = null; for (var i = 1; i < rows.length; i++) if (rows[i].mission_class && rows[i - 1].mission_class && rows[i].mission_class !== rows[i - 1].mission_class) { flip = { between_values: [rows[i - 1].value, rows[i].value], from: rows[i - 1].mission_class, to: rows[i].mission_class }; break; }
    return { contract: CONTRACT, status: 'ok', path: input.path, baseline: r.baseline, rows: rows, first_outcome_change: flip, note: 'Resolution is limited to the supplied values; refine the list near the change for a tighter threshold.' };
  }

  return { version: VERSION, CONTRACT: CONTRACT, SUPPORTED_CHANGES: SUPPORTED, LIMITATIONS: LIMITATIONS, applyChanges: applyChanges, run: run, sweep: sweep };
});
