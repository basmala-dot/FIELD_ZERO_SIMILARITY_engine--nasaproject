/*! FIELD//ZERO final mission results v0.1.0
 *
 *  Combines route simulation, failure analysis, cost/resource engine (and optionally scenario comparisons) into one
 *  structured mission report for the frontend. It computes almost nothing new: every number is taken from the module
 *  that owns it, keeps its provenance tag, and the report ends with explicit data limitations and assumptions.
 *
 *  Pure computation (browser + Node 18+), deterministic, no timestamps (the frontend may add one), never mutates inputs.
 *
 *  ======================================================================================
 *  INPUT   build({ plan, rover, report, failure, cost, scenarios?, recovery?: {action_id?} })
 *            report   FZ-SIM-REPORT-0.1          (required)
 *            failure  FZ-FAILURE-ANALYSIS-0.1    (optional, FieldZeroFailure.analyze)
 *            cost     FZ-COST-0.1                (optional, FieldZeroCost.compute)
 *            scenarios FZ-SCENARIOS-0.1          (optional, FieldZeroScenario.run)
 *            recovery  { action_id }             (optional) report the simulated outcome of an evaluated recovery action
 *          run({ plan, rover, simOptions?, costAssumptions?, telemetry?, scenarios?, recovery?, deps? })
 *            convenience: runs simulation to the end, then failure analysis, cost, (scenarios) and build().
 *  OUTPUT  "FZ-MISSION-RESULTS-0.1"
 *    { meta, progress, objectives, rover_performance, resource_consumption, failures, recovery, cost, success_assessment,
 *      scenarios, provenance, data_limitations[], assumptions[] }
 *    toMarkdown(results) -> string (plain-text brief for export)
 *
 *  SUCCESS RULES (transparent, no hidden score)
 *    SUCCESS              route completed, all required objectives completed, no failure event, no caveat
 *    SUCCESS_WITH_CAVEATS as above but thin margin (risk component >= 0.5) or segments with unknown terrain
 *    PARTIAL              some, but not all, required objectives completed (or route not completed)
 *    FAILED               no required objective completed (or run invalid)
 *    If no required objectives exist, route completion decides (stated in the rationale).
 *    confidence: 'low' when rover parameters are placeholders or terrain data is missing, otherwise 'medium'.
 *    It is never 'high': every value is simulated, none validated against a real rover.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.FieldZeroResults = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function (root) {
  'use strict';

  var VERSION = '0.1.0', CONTRACT = 'FZ-MISSION-RESULTS-0.1';
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function rd(v, d) { if (!isNum(v)) return v; var k = Math.pow(10, d == null ? 3 : d); return Math.round(v * k) / k; }
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function uniq(a) { var s = {}, o = []; a.forEach(function (x) { if (x && !s[x]) { s[x] = 1; o.push(x); } }); return o; }
  function dep(ctx, key, g, file) {
    if (ctx && ctx.deps && ctx.deps[key]) return ctx.deps[key];
    if (root && root[g]) return root[g];
    if (typeof require === 'function') { try { return require(file); } catch (e) { /* optional */ } }
    return null;
  }
  var STATUS_LABEL = { completed: 'Route completed', halted: 'Run stopped by a failure', invalid: 'Invalid input', running: 'Running', paused: 'Paused', idle: 'Not started' };
  var VERDICT_LABEL = { SUCCESS: 'Mission success', SUCCESS_WITH_CAVEATS: 'Mission success with caveats', PARTIAL: 'Partial success', FAILED: 'Mission failed', INVALID_INPUT: 'Cannot assess: invalid input' };

  function rolePerformance(report, cost) {
    var T = report.totals, act = T.time_by_activity_s, dist = T.distance_travelled_this_run_m, E = T.energy;
    var maxS = null, maxR = null, travelled = report.segments.filter(function (s) { return s.traveled_m > 0; });
    travelled.forEach(function (s) { if (s.slope_deg_max != null) maxS = maxS == null ? s.slope_deg_max : Math.max(maxS, s.slope_deg_max); if (s.roughness_std_max != null) maxR = maxR == null ? s.roughness_std_max : Math.max(maxR, s.roughness_std_max); });
    var avg = act.drive > 0 ? dist / act.drive : null, nominal = report.rover.nominal_speed_mps * report.rover.condition.mobility;
    var D = E.decomposition_wh, TD = T.time_decomposition_s, driveE = E.consumed_wh.drive;
    var rows = cost && cost.variance ? cost.variance.rows : [];
    return {
      distance_travelled_m: rd(dist, 1), driving_time_s: rd(act.drive, 1), dwell_time_s: rd(act.dwell, 1), wait_time_s: rd(act.wait, 1), driving_time_share: T.run_elapsed_s > 0 ? rd(act.drive / T.run_elapsed_s, 4) : null,
      average_driving_speed_mps: rd(avg, 5), nominal_speed_mps: rd(report.rover.nominal_speed_mps, 5), speed_vs_condition_adjusted_nominal: nominal > 0 && avg != null ? rd(avg / nominal, 4) : null,
      max_slope_deg_on_travelled_segments: maxS, max_roughness_on_travelled_segments: maxR, effective_slope_limit_deg: rd(report.limits.slope_deg, 2), slope_limit_governed_by: report.limits.slope_governed_by,
      drive_energy_per_km_wh: dist > 0 ? rd(driveE / (dist / 1000), 2) : null,
      terrain_energy_penalty_wh: rd(D.drive_terrain_excess, 2), terrain_time_penalty_s: rd(TD.drive_terrain_slowdown, 1), condition_energy_penalty_wh: rd(D.drive_condition_excess + D.dwell_condition_excess + D.wait_condition_excess, 2), condition_time_penalty_s: rd(TD.drive_condition_slowdown, 1),
      segments_completed: report.segments.filter(function (s) { return s.status === 'completed'; }).length, segments_total: report.segments.length,
      model_vs_estimate: rows.map(function (r) { return { quantity: r.quantity, estimated: r.estimated, simulated: r.simulated, pct_vs_estimate: r.pct_vs_estimate }; }),
      provenance: 'simulated (assumed model); not measured'
    };
  }

  function assess(report, failure, cost, recoveryExec) {
    var os = report.objective_summary, crit = [], rat = [], hardFail = report.events.some(function (e) { return e.severity === 'failure'; });
    var routeDone = report.status === 'completed', reqAll = os.required_total > 0 ? os.required_completed === os.required_total : routeDone;
    var unknown = report.segments.filter(function (s) { return !s.terrain_known; }).length, E = report.totals.energy;
    var lim = report.limits.max_mission_s, margins = failure && failure.margins ? failure.margins : null;
    var thin = margins ? margins.components.filter(function (c) { return c.id !== 'data' && c.risk != null && c.risk >= 0.5; }) : [];
    crit.push({ id: 'route_completed', description: 'The planned route was driven to its end', met: routeDone, value: rd(report.totals.progress_fraction, 4) });
    crit.push({ id: 'required_objectives', description: 'All required objectives completed', met: os.required_total > 0 ? os.required_completed === os.required_total : null, value: os.required_completed + '/' + os.required_total });
    crit.push({ id: 'no_hard_failure', description: 'No failure stopped the run', met: !hardFail, value: report.halted ? report.halted.code : null });
    crit.push({ id: 'energy_reserve', description: 'Battery stayed above its reserve', met: E.min_wh >= E.reserve_wh - 1e-6, value: rd(E.min_wh - E.reserve_wh, 2) + ' Wh above reserve at the lowest point' });
    crit.push({ id: 'time_limit', description: 'Finished within the mission time limit', met: lim == null ? null : report.totals.elapsed_s <= lim + 1e-6, value: lim == null ? 'no limit defined' : rd(report.totals.elapsed_s, 0) + ' of ' + rd(lim, 0) + ' s' });
    crit.push({ id: 'terrain_data_complete', description: 'Terrain slope known for every segment', met: unknown === 0, value: (report.segments.length - unknown) + '/' + report.segments.length + ' segments' });
    var verdict;
    if (report.status === 'invalid') verdict = 'INVALID_INPUT';
    else if (reqAll && routeDone && !hardFail) verdict = (thin.length || unknown) ? 'SUCCESS_WITH_CAVEATS' : 'SUCCESS';
    else verdict = os.required_completed > 0 || (os.required_total === 0 && report.totals.progress_fraction > 0) ? 'PARTIAL' : 'FAILED';
    if (os.required_total === 0) rat.push('No required objectives are defined in the plan, so success is judged on route completion only.');
    rat.push(os.required_completed + ' of ' + os.required_total + ' required objective(s) completed; route ' + rd((report.totals.progress_fraction || 0) * 100, 1) + '% complete.');
    if (report.halted) rat.push('The run stopped on ' + report.halted.code + ': ' + report.halted.message);
    thin.forEach(function (c) { rat.push('Thin ' + c.id + ' margin (' + rd(c.margin_frac * 100, 1) + '%).'); });
    if (unknown) rat.push(unknown + ' segment(s) have unknown terrain, so limit checks there are not possible.');
    var conf = (report.rover.parameter_provenance !== 'supplied' || unknown) ? 'low' : 'medium';
    var out = { verdict: verdict, label: VERDICT_LABEL[verdict], confidence: conf, confidence_note: 'Capped at medium: all values are simulated with an assumed model and none are validated against a real rover. Low when rover parameters are placeholders or terrain data is missing.', criteria: crit, rationale: rat, provenance: 'derived from simulated values' };
    if (recoveryExec && recoveryExec.executed) {
      var o = recoveryExec.outcome;
      out.with_recovery_simulated = { action_id: recoveryExec.action_id, mission_class: o.mission_class, required_completed: o.required_completed, required_total: o.required_total, feasible: recoveryExec.feasible, note: recoveryExec.feasibility_reason, provenance: recoveryExec.provenance };
    }
    return out;
  }

  function build(input) {
    input = input || {};
    var report = input.report, failure = input.failure || null, cost = input.cost && input.cost.status === 'ok' ? input.cost : null, plan = input.plan || null;
    if (!report || report.contract !== 'FZ-SIM-REPORT-0.1') return { contract: CONTRACT, version: VERSION, status: 'invalid_input', error: 'report (FZ-SIM-REPORT-0.1) is required.' };
    var Fail = dep(input, 'failure', 'FieldZeroFailure', './failure-analysis.js');
    if (report.validation.errors.length) return { contract: CONTRACT, version: VERSION, status: 'invalid_input', error: 'Simulation input was invalid: ' + report.validation.errors.join('; '), success_assessment: { verdict: 'INVALID_INPUT', label: VERDICT_LABEL.INVALID_INPUT }, data_limitations: report.validation.warnings };
    var T = report.totals, os = report.objective_summary;
    var execd = (input.recovery && Fail && failure) ? Fail.executeRecovery(failure, input.recovery.action_id) : null;

    var progress = { status: report.status, status_label: STATUS_LABEL[report.status] || report.status, progress_fraction: rd(T.progress_fraction, 4), distance_in_plan_m: rd(T.distance_in_plan_m, 1), planned_distance_m: rd(T.planned_distance_m, 1),
      elapsed_s: rd(T.elapsed_s, 1), time_limit_s: report.limits.max_mission_s, segments_completed: report.segments.filter(function (s) { return s.status === 'completed'; }).length, segments_total: report.segments.length,
      stopped_by: report.halted ? { code: report.halted.code, message: report.halted.message, t_s: rd(report.halted.t_s, 1), segment_index: report.halted.segment_index } : null,
      last_position: report.trace.length ? { x_m: report.trace[report.trace.length - 1].x_m, y_m: report.trace[report.trace.length - 1].y_m, provenance: 'simulated' } : null, provenance: 'simulated' };
    var objectives = { total: os.total, completed: report.objectives.filter(function (o) { return o.status === 'completed'; }), incomplete: report.objectives.filter(function (o) { return o.status === 'incomplete'; }), skipped: report.objectives.filter(function (o) { return o.status === 'skipped'; }),
      required_completed: os.required_completed, required_total: os.required_total, required_completion_fraction: os.required_total ? rd(os.required_completed / os.required_total, 4) : null,
      note: os.total === 0 ? 'The plan defines no objectives.' : null, provenance: 'simulated from planner-defined objectives' };

    var E = report.totals.energy;
    var resource = { energy: { start_wh: rd(E.start_wh, 2), end_wh: rd(E.end_wh, 2), lowest_wh: rd(E.min_wh, 2), reserve_wh: rd(E.reserve_wh, 2), usable_capacity_wh: rd(E.usable_capacity_wh, 2), consumed_wh: { drive: rd(E.consumed_wh.drive, 2), dwell: rd(E.consumed_wh.dwell, 2), wait: rd(E.consumed_wh.wait, 2), total: rd(E.consumed_wh.total, 2) },
        generated_wh: rd(E.generated_wh, 2), curtailed_wh: rd(E.curtailed_wh, 2), balance_check_wh: E.balance_check_wh, provenance: 'simulated' },
      time: { elapsed_s: rd(T.elapsed_s, 1), by_activity_s: T.time_by_activity_s, limit_s: report.limits.max_mission_s, provenance: 'simulated' },
      equipment: cost ? cost.ledger.equipment : [], consumables: cost ? cost.ledger.consumables : [], remaining: cost ? cost.remaining : null, shortages: cost ? cost.shortages : [],
      note: cost ? null : 'Cost/resource engine output not supplied: equipment, consumables, remaining resources and shortages are omitted.' };

    var failures = failure && failure.status !== 'invalid_input' ? { status: failure.status, count: failure.failures.length, summary: failure.summary, risk: failure.margins ? { index: failure.margins.risk_index, components: failure.margins.components, formula: failure.margins.formula } : null, warnings: failure.warnings,
      items: failure.failures.map(function (f) { return { id: f.id, code: f.code, severity: f.severity, t_s: rd(f.t_s, 1), location: f.location, message: f.message, primary_cause: f.causes.primary, cause_summary: f.causes.summary, cause_evidence: f.causes.evidence, consequences: f.consequences, mission_impact: f.mission_impact }; }) }
      : { status: 'not_analysed', count: report.events.filter(function (e) { return e.severity === 'failure'; }).length, items: [], note: 'failure-analysis output not supplied; only the simulator event count is shown.' };

    var stopF = failure && failure.failures ? failure.failures.filter(function (f) { return f.consequences.stops_mission; })[0] : null;
    var recovery = stopF ? { evaluated: stopF.recovery.evaluated, feasibility: stopF.recovery.feasibility, best_action_id: stopF.recovery.best_action_id, explanation: stopF.recovery.explanation, failure_id: stopF.id,
        actions: stopF.recovery.actions.map(function (a) { return { id: a.id, type: a.type, description: a.description, applicable: a.applicable, feasible: a.feasible, feasibility_reason: a.feasibility_reason, requires: a.requires, estimate: a.estimate, outcome: a.outcome, tradeoffs: a.tradeoffs }; }),
        executed: execd, status_note: execd && execd.executed ? 'Outcome shown is a simulated continuation; no real operation took place.' : 'Recovery options are evaluated (simulated), none has been executed.' }
      : { evaluated: false, feasibility: failure ? 'not_needed' : 'not_analysed', actions: [], executed: null, explanation: failure ? 'No mission-stopping failure occurred.' : 'failure-analysis output not supplied.' };

    var costBlock = cost ? { currency: cost.cost.currency, rate_provenance: cost.assumptions.provenance, rates: cost.assumptions.rates, estimated_total: cost.cost.estimated ? cost.cost.estimated.total : null, simulated_total: cost.cost.simulated.total, measured_total: cost.cost.measured ? cost.cost.measured.total : null,
        measured_available: !!cost.cost.measured, components_simulated: cost.cost.simulated.components, components_estimated: cost.cost.estimated ? cost.cost.estimated.components : null, variance: cost.variance, cost_per_km_simulated: cost.cost.cost_per_km_simulated,
        note: 'Estimated = pre-run analytic; simulated = accumulated by the run; measured = real telemetry (null unless supplied). Rates are ' + cost.assumptions.provenance + '.' } : { note: 'Cost output not supplied.' };

    var terrainSources = uniq(report.segments.map(function (s) { return s.terrain_known ? (s.terrain_source || 'plan (source not labelled)') : 'unknown'; }));
    var provenance = [
      { item: 'Route geometry and waypoints', class: 'real/plan input', detail: 'As supplied by the planning engine (provisional contract); not generated here.' },
      { item: 'Terrain per segment', class: terrainSources.indexOf('unknown') !== -1 ? 'plan input with gaps' : 'plan input', detail: 'Sources: ' + terrainSources.join(', ') },
      { item: 'Rover parameters', class: report.rover.parameter_provenance === 'supplied' ? 'caller-supplied' : 'assumed', detail: 'Rover id ' + report.rover_id },
      { item: 'Position, speed, time, energy', class: 'simulated', detail: 'Linear speed/power rules (see assumptions); not a validated dynamics model.' },
      { item: 'Pre-run estimates', class: 'estimated', detail: 'Analytic, same assumed model.' },
      { item: 'Cost', class: cost ? 'derived (' + cost.assumptions.provenance + ' rates)' : 'not computed', detail: cost ? cost.assumptions.currency : '' },
      { item: 'Measured telemetry', class: cost && cost.cost.measured ? 'measured (caller-supplied)' : 'none', detail: cost && cost.cost.measured ? 'Supplied by the caller.' : 'No real rover measurements exist in this project.' }
    ];

    var lim = [];
    report.validation.warnings.forEach(function (w) { lim.push(w); });
    report.data_gaps.forEach(function (g) { lim.push(g.message); });
    lim.push('The route comes from the planning engine through a PROVISIONAL contract; field mapping may change when the final planning API is available.');
    if (!(cost && cost.cost.measured)) lim.push('No measured telemetry: all "actual" values are simulated, not observed.');
    [Fail && Fail.LIMITATIONS, cost && cost.limitations].forEach(function (l) { (l || []).forEach(function (x) { lim.push(x); }); });
    var assumptions = uniq((report.assumptions || []).concat(failure && failure.assumptions ? failure.assumptions : [], cost && cost.assumptions ? ['Cost rates: ' + cost.assumptions.provenance + ' (' + Object.keys(cost.assumptions.rates).map(function (k) { return k + '=' + cost.assumptions.rates[k] + ' ' + cost.assumptions.rate_units[k]; }).join('; ') + ').'] : []));

    var sc = input.scenarios && input.scenarios.status === 'ok' ? { baseline: input.scenarios.baseline, ranking: input.scenarios.ranking, items: input.scenarios.scenarios.map(function (s) { return { id: s.id, name: s.name, outcome_change: s.outcome_change, delta_vs_baseline: s.delta_vs_baseline, explanation: s.explanation, attribution: s.attribution || null }; }), limitations: input.scenarios.limitations } : null;

    return { contract: CONTRACT, version: VERSION, status: 'ok', deterministic: true,
      meta: { plan_id: report.plan_id, plan_name: report.plan_name, body: report.body, rover_id: report.rover_id, modules: { simulation: report.version, failure: failure ? failure.version : null, cost: cost ? cost.version : null, scenarios: input.scenarios ? input.scenarios.version : null, results: VERSION },
        plan_contract: 'FZ-PLAN-PROVISIONAL-0.1' },
      progress: progress, objectives: objectives, rover_performance: rolePerformance(report, cost), resource_consumption: resource, failures: failures, recovery: recovery, cost: costBlock,
      success_assessment: assess(report, failure, cost, execd), scenarios: sc, provenance: provenance, data_limitations: uniq(lim), assumptions: assumptions };
  }

  function run(input) {
    input = input || {};
    var Sim = dep(input, 'simulation', 'FieldZeroSim', './route-simulation.js'), Fail = dep(input, 'failure', 'FieldZeroFailure', './failure-analysis.js'), Cost = dep(input, 'cost', 'FieldZeroCost', './cost-engine.js'), Sc = dep(input, 'scenarios', 'FieldZeroScenario', './scenario-engine.js');
    if (!Sim) return { contract: CONTRACT, version: VERSION, status: 'error', error: 'route-simulation module (FieldZeroSim) is required.' };
    var so = Object.assign({}, input.simOptions || {}, { rover: input.rover });
    var report = Sim.createSimulation(input.plan, so).runToEnd(), deps = { simulation: Sim, failure: Fail, cost: Cost };
    var failure = Fail ? Fail.analyze(report, { plan: input.plan, rover: input.rover, deps: deps }) : null;
    var cost = Cost ? Cost.compute({ report: report, plan: input.plan, rover: input.rover, assumptions: input.costAssumptions, telemetry: input.telemetry, deps: deps }) : null;
    var scenarios = (Sc && input.scenarios && input.scenarios.length) ? Sc.run({ plan: input.plan, rover: input.rover, scenarios: input.scenarios, deps: deps, assumptions: input.costAssumptions, options: input.simOptions && input.simOptions.onViolation ? { onViolation: input.simOptions.onViolation } : {} }) : null;
    var res = build({ plan: input.plan, rover: input.rover, report: report, failure: failure, cost: cost, scenarios: scenarios, recovery: input.recovery, deps: deps });
    res.raw = input.includeRaw ? { report: report, failure: failure, cost: cost, scenarios: scenarios } : undefined;
    return res;
  }

  function toMarkdown(r) {
    if (!r || r.status !== 'ok') return '# FIELD//ZERO mission results\n\nNo results: ' + (r && r.error || 'invalid input') + '\n';
    var L = [], p = r.progress, a = r.success_assessment, e = r.resource_consumption.energy, f = function (v, d) { return isNum(v) ? String(rd(v, d == null ? 2 : d)) : 'n/a'; };
    L.push('# FIELD//ZERO mission results', '', '_Simulated values under an assumed rover model. Not a validated prediction._', '', '## Verdict', '**' + a.label + '** (confidence: ' + a.confidence + ')', '');
    a.rationale.forEach(function (x) { L.push('- ' + x); });
    L.push('', '## Progress', '- Status: ' + p.status_label, '- Route: ' + f(p.progress_fraction * 100, 1) + '% (' + p.segments_completed + '/' + p.segments_total + ' segments), ' + f(p.distance_in_plan_m, 0) + ' of ' + f(p.planned_distance_m, 0) + ' m', '- Elapsed: ' + f(p.elapsed_s / 3600, 2) + ' h');
    L.push('', '## Objectives', '- Required: ' + r.objectives.required_completed + '/' + r.objectives.required_total);
    r.objectives.completed.forEach(function (o) { L.push('- [x] ' + o.id + (o.required ? '' : ' (optional)')); });
    r.objectives.incomplete.forEach(function (o) { L.push('- [ ] ' + o.id + (o.required ? '' : ' (optional)')); });
    L.push('', '## Resources', '- Energy: start ' + f(e.start_wh, 1) + ' Wh, end ' + f(e.end_wh, 1) + ' Wh, lowest ' + f(e.lowest_wh, 1) + ' Wh (reserve ' + f(e.reserve_wh, 1) + ' Wh); consumed ' + f(e.consumed_wh.total, 1) + ' Wh');
    r.resource_consumption.shortages.forEach(function (s) { L.push('- Shortage ' + s.resource + ': ' + f(s.shortfall_lower) + ' to ' + f(s.shortfall_upper) + ' ' + s.unit + ' (' + s.provenance + ')'); });
    L.push('', '## Failures and recovery', '- ' + (r.failures.summary ? r.failures.summary.text : r.failures.count + ' failure event(s)'));
    r.failures.items.forEach(function (x) { L.push('- ' + x.code + ' at t=' + f(x.t_s / 3600, 2) + ' h: ' + x.cause_summary); });
    L.push('- Recovery: ' + r.recovery.explanation);
    if (r.cost.simulated_total != null) L.push('', '## Cost (' + r.cost.currency + ')', '- Estimated: ' + f(r.cost.estimated_total, 1) + ' | Simulated: ' + f(r.cost.simulated_total, 1) + ' | Measured: ' + (r.cost.measured_available ? f(r.cost.measured_total, 1) : 'none supplied'), '- Rates: ' + r.cost.rate_provenance);
    L.push('', '## Data limitations'); r.data_limitations.forEach(function (x) { L.push('- ' + x); });
    L.push('', '## Assumptions'); r.assumptions.forEach(function (x) { L.push('- ' + x); });
    return L.join('\n') + '\n';
  }

  return { version: VERSION, CONTRACT: CONTRACT, build: build, run: run, toMarkdown: toMarkdown };
});
