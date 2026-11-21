// FIELD//ZERO simulation & mission operations: integration test on REAL project data.
// Usage (project root): node scripts/test_simulation_ops.js
// FIXTURE NOTE: the plan below is a TEST FIXTURE, not a planned route. Waypoints are real sites from outputs/mission_portfolio.json,
// ordered nearest-neighbour and joined by straight lines; slope/roughness are real values from the Earth 120 m terrain CSV sampled along
// each line. Objectives, dwell times and the rover are invented test inputs (labelled as such).
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..'), J = (p) => path.join(root, 'website/js', p);
const Sim = require(J('route-simulation.js')), Fail = require(J('failure-analysis.js')), Cost = require(J('cost-engine.js')), Sc = require(J('scenario-engine.js')), Res = require(J('mission-results.js'));
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };

// ---- real data
const csv = fs.readFileSync(path.join(root, 'Data/processed/Earth files/earth_western_desert_120m_terrain.csv'), 'utf8').split(/\r?\n/);
const hdr = csv[0].split(','), ix = n => hdr.indexOf(n), grid = new Map();
for (let i = 1; i < csv.length; i++) { if (!csv[i]) continue; const c = csv[i].split(','); grid.set(Math.round(+c[ix('x_m_localTM')] / 120) + ',' + Math.round(+c[ix('y_m_localTM')] / 120), { slope: c[ix('slope_deg')] === '' ? null : +c[ix('slope_deg')], rough: c[ix('roughness_std')] === '' ? null : +c[ix('roughness_std')], tri: c[ix('tri')] === '' ? null : +c[ix('tri')] }); }
const cellAt = (x, y) => grid.get(Math.round(x / 120) + ',' + Math.round(y / 120));
const port = JSON.parse(fs.readFileSync(path.join(root, 'outputs/mission_portfolio.json'))).portfolios.mars.items;
let rest = port.map((p, i) => ({ id: 'SITE' + (i + 1), x_m: p.x_m_localTM, y_m: p.y_m_localTM, lon_deg: p.lon_deg, lat_deg: p.lat_deg, elevation_m: p.elevation_m }));
const order = [rest.shift()]; while (rest.length) { const l = order[order.length - 1]; rest.sort((a, b) => Math.hypot(a.x_m - l.x_m, a.y_m - l.y_m) - Math.hypot(b.x_m - l.x_m, b.y_m - l.y_m)); order.push(rest.shift()); }
const segments = [];
for (let i = 0; i < order.length - 1; i++) {
  const a = order[i], b = order[i + 1], L = Math.hypot(b.x_m - a.x_m, b.y_m - a.y_m), n = Math.max(2, Math.ceil(L / 120)), sl = [], rg = [];
  for (let k = 0; k <= n; k++) { const c = cellAt(a.x_m + (b.x_m - a.x_m) * k / n, a.y_m + (b.y_m - a.y_m) * k / n); if (c && c.slope != null) { sl.push(c.slope); rg.push(c.rough); } }
  segments.push({ length_m: L, slope_deg: sl.reduce((s, v) => s + v, 0) / sl.length, slope_deg_max: Math.max(...sl), roughness_std: rg.reduce((s, v) => s + v, 0) / rg.length, roughness_std_max: Math.max(...rg), terrain_source: 'Earth 120 m DEM-derived (NASADEM) sampled along a straight line (test fixture)' });
}
const plan = { contract: 'FZ-PLAN-PROVISIONAL-0.1', id: 'TEST-FIXTURE', name: 'Fixture: portfolio sites joined by straight lines', body: 'earth', waypoints: order, segments,
  objectives: order.slice(1).map((w, i) => ({ id: 'OBJ-' + w.id, waypoint_id: w.id, dwell_s: 1800, required: i < 3, requires: [{ resource_id: 'sample_tubes', quantity: 1 }] })),
  constraints: { max_slope_deg: 25, max_mission_s: 150 * 3600 }, resources: [{ id: 'sample_tubes', name: 'Sample tubes', unit: 'pcs', available: 3, unit_cost: 10 }] };
const rover = { id: 'TEST-ROVER', nominal_speed_mps: 0.15, max_slope_deg: 30, battery_capacity_wh: 18000, parameter_provenance: 'supplied', equipment: [{ id: 'drill', name: 'Drill', duty: 'dwell', available_hours: 3, cost_per_hour: 20 }] };
console.log('fixture: ' + order.length + ' waypoints, ' + Math.round(segments.reduce((s, g) => s + g.length_m, 0)) + ' m, slope max ' + Math.max(...segments.map(s => s.slope_deg_max)).toFixed(1) + ' deg');

// ---- 1 simulation
const r1 = Sim.run(plan, { rover }), r2 = Sim.run(plan, { rover });
ok(JSON.stringify(r1) === JSON.stringify(r2), 'deterministic: two runs give identical reports');
ok(r1.validation.errors.length === 0, 'plan validates');
console.log('   baseline:', r1.status, r1.halted && r1.halted.code, 'elapsed h', (r1.totals.elapsed_s / 3600).toFixed(1), 'consumed Wh', r1.totals.energy.consumed_wh.total.toFixed(0), 'progress', r1.totals.progress_fraction);
ok(Math.abs(r1.totals.energy.balance_check_wh) < 1e-6, 'energy balance closes (|err| ' + Math.abs(r1.totals.energy.balance_check_wh).toExponential(1) + ' Wh)');
const outcome = r => [r.status, r.totals.elapsed_s.toFixed(3), r.totals.energy.consumed_wh.total.toFixed(4), r.objective_summary.completed].join('|');
ok(outcome(Sim.createSimulation(plan, { rover, stepSeconds: 7 }).runToEnd()) === outcome(r1), 'outcome independent of step size (runToEnd)');
const c = Sim.createSimulation(plan, { rover, stepSeconds: 3600 }); let st; while ((st = c.tick()).status === 'paused' || st.status === 'idle') { if (st.tick > 5000) break; }
ok(outcome(c.getReport()) === outcome(r1), 'manual ticking of 3600 s reaches the same final outcome (' + st.tick + ' ticks)');
ok(Math.abs(st.route.progress_fraction - 1) < 1e-9 && st.status === 'completed', 'state reports completed with progress 1');
const est = Sim.estimatePlan(plan, rover).estimate;
ok(Math.abs(est.time_s - r1.totals.elapsed_s) < 1e-3 && Math.abs(est.energy_wh - r1.totals.energy.consumed_wh.total) < 1e-3, 'analytic estimate equals simulated totals when nothing fails');

// play / pause / resume / reset with fake scheduler
let fn = null, cleared = 0; const sched = { setInterval: f => { fn = f; return 1; }, clearInterval: () => { cleared++; fn = null; } };
const pc = Sim.createSimulation(plan, { rover, stepSeconds: 1000, scheduler: sched }); const seen = []; pc.on('state', s => seen.push(s.status));
pc.play(); fn(); fn(); const t1 = pc.getState().time.elapsed_s; pc.pause(); ok(fn === null && pc.getState().status === 'paused', 'pause stops the timer');
ok(pc.getState().time.elapsed_s === t1, 'state frozen while paused'); pc.resume(); fn(); ok(pc.getState().time.elapsed_s > t1 && pc.getState().status === 'running', 'resume continues from the paused state');
const mid = pc.getState().time.elapsed_s; pc.reset(); ok(pc.getState().time.elapsed_s === 0 && pc.getState().status === 'idle', 'reset returns to the initial state'); pc.play(); fn(); fn(); fn(); ok(pc.getState().time.elapsed_s === mid, 'replay after reset is repeatable');

// limits
const slopeHalt = Sim.run(plan, { rover: { ...rover, max_slope_deg: 3 } }); ok(slopeHalt.halted && slopeHalt.halted.code === 'SLOPE_EXCEEDS_LIMIT', 'rover slope capability halts the run: ' + (slopeHalt.halted && slopeHalt.halted.message));
const blocked = Sim.run({ ...plan, segments: plan.segments.map((s, i) => i === 1 ? { ...s, passable: false } : s) }, { rover }); ok(blocked.halted && blocked.halted.code === 'SEGMENT_BLOCKED' && blocked.halted.segment_index === 1, 'planner-blocked segment halts at its entry');
const small = Sim.run(plan, { rover: { ...rover, battery_capacity_wh: 3000 } }); ok(small.halted && small.halted.code === 'BATTERY_BELOW_RESERVE' && Math.abs(small.totals.energy.end_wh - small.totals.energy.reserve_wh) < 1e-4, 'battery halt happens exactly at the reserve');
const slow = Sim.run({ ...plan, constraints: { ...plan.constraints, max_mission_s: 20 * 3600 } }, { rover }); ok(slow.halted && slow.halted.code === 'TIME_LIMIT_REACHED' && Math.abs(slow.totals.elapsed_s - 72000) < 1e-3, 'time limit halts exactly at the limit');
const noPlan = Sim.run({ waypoints: [{ id: 'A', x_m: 0, y_m: 0 }] }, { rover }); ok(noPlan.status === 'invalid' && noPlan.validation.errors.length > 0, 'a plan without a route is rejected, not invented');
const noTerrain = Sim.run({ ...plan, segments: [] }, { rover }); ok(noTerrain.data_gaps.some(g => g.code === 'SEGMENT_SLOPE_MISSING') && noTerrain.events.some(e => e.code === 'TERRAIN_DATA_MISSING'), 'missing terrain is flagged as a data gap');

// ---- 3 failure analysis
const fSlope = Fail.analyze(slopeHalt, { plan, rover });
ok(fSlope.status === 'failure_detected' && fSlope.failures[0].causes.primary === 'rover_slope_capability', 'slope failure cause identified: ' + fSlope.failures[0].causes.summary);
const fBat = Fail.analyze(small, { plan, rover }), fb = fBat.failures[0];
ok(fb.code === 'BATTERY_BELOW_RESERVE' && fb.causes.demand_side && Math.abs(fb.causes.demand_side.reduce((s, x) => s + x.wh, 0) - small.totals.energy.consumed_wh.total) < 0.01, 'battery demand-side decomposition sums to consumed energy');
ok(fb.recovery.evaluated && fb.recovery.actions.find(a => a.id === 'WAIT_RECHARGE').applicable === false, 'no charging source defined: recharge reported unsupported, not guessed');
ok(fb.mission_impact.outcome_without_recovery !== 'SUCCESS', 'failure impact: ' + fb.mission_impact.text);
const planSolar = { ...plan, environment: { solar_input_w: 60 } };
const tiny = { ...rover, battery_capacity_wh: 3000 }, mid6 = { ...rover, battery_capacity_wh: 6000 };
const wTiny = Fail.analyze(Sim.run(planSolar, { rover: tiny }), { plan: planSolar, rover: tiny }).failures[0].recovery.actions.find(a => a.id === 'WAIT_RECHARGE');
ok(wTiny.applicable && wTiny.feasible === false && /full battery/.test(wTiny.feasibility_reason), 'recharge infeasible when even a full battery cannot finish: ' + wTiny.feasibility_reason);
const run6 = Sim.run(planSolar, { rover: mid6 }), f6 = Fail.analyze(run6, { plan: planSolar, rover: mid6 });
ok(run6.halted && run6.halted.code === 'BATTERY_BELOW_RESERVE', '6000 Wh + 60 W solar still halts on battery reserve');
const w6 = f6.failures[0].recovery.actions.find(a => a.id === 'WAIT_RECHARGE'); console.log('   recharge:', w6.feasible, w6.feasibility_reason, JSON.stringify(w6.estimate));
ok(w6.applicable && w6.feasible && w6.estimate.action_time_s > 0 && f6.failures[0].recovery.feasibility === 'full', 'with a charging source the recharge wait is evaluated and feasible (' + (w6.estimate.action_time_s / 3600).toFixed(2) + ' h)');
const rep = d => Sim.run(planSolar, { rover: mid6, initial: run6.resume, preActions: [{ type: 'WAIT', duration_s: d }], traceEveryS: 1e9 });
ok(rep(w6.estimate.action_time_s).status === 'completed', 'independent replay of the recommended wait completes the route');
ok(rep(w6.estimate.action_time_s - 5).status !== 'completed', 'the recommended wait is minimal (5 s less fails)');
// alternative route
const bi = 1, A = plan.waypoints[bi], B = plan.waypoints[bi + 1], mx = (A.x_m + B.x_m) / 2 + 800, my = (A.y_m + B.y_m) / 2 + 800;
const planAlt = { ...plan, segments: plan.segments.map((s, i) => i === bi ? { ...s, passable: false } : s), alternatives: [{ id: 'DETOUR-TEST', from: A.id, to: B.id, waypoints: [{ id: 'VIA', x_m: mx, y_m: my }], segments: [{ length_m: Math.hypot(mx - A.x_m, my - A.y_m), slope_deg: 3, slope_deg_max: 5 }, { length_m: Math.hypot(B.x_m - mx, B.y_m - my), slope_deg: 3, slope_deg_max: 5 }] }] };
const rAlt = Sim.run(planAlt, { rover }), fAlt = Fail.analyze(rAlt, { plan: planAlt, rover }), alt = fAlt.failures[0].recovery.actions.find(a => a.type === 'ALTERNATE_ROUTE');
ok(alt && alt.applicable && alt.outcome && alt.outcome.status === 'completed', 'planner-supplied detour is evaluated and completes (detour fixture is invented test input)');
ok(fAlt.failures[0].recovery.feasibility === 'full' && fAlt.failures[0].mission_impact.outcome_with_best_recovery === 'SUCCESS', 'blocked segment: recovery feasible with detour -> ' + fAlt.failures[0].mission_impact.text);
const fNoAlt = Fail.analyze(blocked, { plan, rover }); ok(fNoAlt.failures[0].recovery.actions.find(a => a.id === 'ALTERNATE_ROUTE').applicable === false && /does not invent routes/.test(fNoAlt.failures[0].recovery.actions.find(a => a.id === 'ALTERNATE_ROUTE').feasibility_reason), 'no planner alternatives: reported, route not invented');
const fTime = Fail.analyze(slow, { plan: { ...plan, constraints: { ...plan.constraints, max_mission_s: 20 * 3600 } }, rover }); const ext = fTime.failures[0].recovery.actions.find(a => a.id === 'EXTEND_TIME_LIMIT'); ok(ext.outcome && ext.estimate.extra_time_needed_s > 0, 'time failure: extra time needed ' + (ext.estimate.extra_time_needed_s / 3600).toFixed(1) + ' h');
ok(Fail.analyze(r1, { plan, rover }).status === 'no_failure', 'baseline: no failure detected');

// ---- 4 cost
const co = Cost.compute({ report: r1, plan, rover }); ok(co.status === 'ok', 'cost engine runs');
ok(Math.abs(co.cost.simulated.total - co.cost.simulated.components.reduce((s, x) => s + (x.amount || 0), 0)) < 0.01, 'cost total equals the sum of its components');
ok(co.actuals.measured === null && co.notes.some(n => /No telemetry/.test(n)), 'no telemetry -> measured is null and said so');
ok(co.cost.estimated && Math.abs(co.cost.estimated.total - co.cost.simulated.total) < 0.5, 'estimated vs simulated cost agree when nothing fails (same model)');
const coT = Cost.compute({ report: r1, plan, rover, telemetry: { elapsed_s: r1.totals.elapsed_s * 1.1, energy_consumed_wh: r1.totals.energy.consumed_wh.total * 1.05 } }); ok(coT.actuals.measured && coT.cost.measured.complete === false && coT.variance.rows[0].measured_minus_simulated > 0, 'caller telemetry is kept separate (measured) with incomplete cost flagged');
ok(co.ledger.consumables[0].remaining === 3 - r1.objective_summary.completed && co.ledger.equipment[0].hours_used === 2, 'consumables and equipment hours tracked (drill ' + co.ledger.equipment[0].hours_used + ' h of 3 h)');
const coS = Cost.compute({ report: small, plan, rover: { ...rover, battery_capacity_wh: 3000 } }); ok(coS.shortages.some(s => s.resource === 'energy'), 'unfinished run: energy shortage estimated: ' + JSON.stringify(coS.shortages.filter(s => s.resource === 'energy').map(s => [s.shortfall_lower, s.shortfall_upper])));

// ---- 2 scenarios
const scn = Sc.run({ plan, rover, scenarios: [
  { id: 'weak-battery', name: 'Degraded battery + steeper terrain', changes: { rover_condition: { battery_health: 0.5 }, route_conditions: { slope_scale: 1.5 } } },
  { id: 'solar', name: 'Add 100 W charging, tighter time', changes: { resources: { solar_input_w: 100 }, duration: { max_mission_scale: 0.9 } } },
  { id: 'bad-input', changes: { resources: { battery_capacity_scale: -1, nonsense: 1 }, foo: {} } }] });
ok(scn.status === 'ok' && scn.scenarios.length === 3, 'scenario run ok');
const wb = scn.scenarios[0]; ok(wb.status === 'ok' && wb.attribution.per_change.length === 2 && wb.explanation.length >= 4, 'scenario compared with explanation and per-change attribution');
console.log('   baseline', scn.baseline.mission_class, '| weak-battery', wb.summary.mission_class, wb.summary.halted_code, '| attribution', JSON.stringify(wb.attribution.per_change.map(p => [p.path, p.mission_class, p.progress_pts_vs_baseline])), wb.attribution.note);
ok(scn.scenarios[2].status === 'no_changes_applied' && scn.scenarios[2].ignored.length >= 2, 'invalid changes are ignored and listed, not silently applied');
ok(JSON.stringify(Sc.run({ plan, rover, scenarios: [{ id: 'x', changes: { rover_condition: { mobility: 0.5 } } }] })) === JSON.stringify(Sc.run({ plan, rover, scenarios: [{ id: 'x', changes: { rover_condition: { mobility: 0.5 } } }] })), 'scenario results are deterministic');
const before = JSON.stringify(plan) + JSON.stringify(rover); Sc.run({ plan, rover, scenarios: [{ id: 'm', changes: { route_conditions: { slope_scale: 2, blocked_segments: [0] } } }] }); ok(before === JSON.stringify(plan) + JSON.stringify(rover), 'scenario engine does not mutate plan or rover');
const sw = Sc.sweep({ plan, rover, path: 'resources.battery_capacity_scale', values: [0.3, 0.5, 0.7, 0.9, 1.1] }); console.log('   sweep:', JSON.stringify(sw.rows.map(r => [r.value, r.mission_class, +r.progress_fraction.toFixed(2)])), JSON.stringify(sw.first_outcome_change)); ok(sw.status === 'ok', 'sweep runs');

// ---- 5 results
const res = Res.run({ plan, rover, scenarios: [{ id: 'weak-battery', changes: { rover_condition: { battery_health: 0.5 } } }], includeRaw: false });
ok(res.status === 'ok' && res.success_assessment.verdict && res.data_limitations.length > 3, 'mission results (baseline): ' + res.success_assessment.label + ', confidence ' + res.success_assessment.confidence);
const resF = Res.run({ plan, rover: { ...rover, battery_capacity_wh: 3000 }, recovery: { action_id: 'DESCOPE_OPTIONAL' } });
ok(['PARTIAL', 'FAILED'].includes(resF.success_assessment.verdict) && resF.failures.count >= 1 && resF.recovery.actions.length >= 1, 'mission results (failed run): ' + resF.success_assessment.label + '; recovery ' + resF.recovery.feasibility);
const resP = Res.run({ plan: planAlt, rover, recovery: {} }); ok(resP.success_assessment.with_recovery_simulated && resP.success_assessment.with_recovery_simulated.mission_class === 'SUCCESS', 'recovery outcome reported as simulated: ' + resP.recovery.status_note);
const bad = Res.run({ plan: { waypoints: [] }, rover }); ok(bad.status === 'invalid_input', 'invalid plan yields invalid_input results, not a fabricated report');
const hasBad = o => { let b = false; JSON.stringify(o, (k, v) => { if (typeof v === 'number' && !isFinite(v)) b = true; return v; }); return b; };
ok(!hasBad(res) && !hasBad(resF) && !hasBad(scn) && !hasBad(co), 'no NaN/Infinity anywhere in outputs');
ok(Res.toMarkdown(resF).includes('Data limitations'), 'markdown export works');
fs.mkdirSync(path.join(root, 'outputs'), { recursive: true });
console.log('\n' + (fails ? fails + ' CHECK(S) FAILED' : 'ALL CHECKS PASSED')); process.exit(fails ? 1 : 0);
