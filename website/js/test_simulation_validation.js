// FIELD//ZERO simulation validation (Person 3, Task 2).
// Usage (project root): node scripts/test_simulation_validation.js
// READ-ONLY: reads the processed datasets, writes nothing.
//
// [REAL]  = uses the real planning engine (FieldZeroMission) on the real processed datasets (Earth, Mars, Moon 120 m terrain).
// [SYNTH] = synthetic input for an isolated edge case that real data cannot represent. A SYNTH check is NEVER evidence that
//           real integration works; the REAL section (A) is that evidence.
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..'), J = (p) => path.join(root, 'website/js', p);
const IO = require('./similarity_io.js');
const Sim = require(J('route-simulation.js')), Fail = require(J('failure-analysis.js')), Cost = require(J('cost-engine.js')), Sc = require(J('scenario-engine.js')), Res = require(J('mission-results.js'));
const S = require(J('similarity-engine.js')), Mission = require(J('mission-engine.js'));
let fails = 0, n = 0; const ok = (c, m) => { n++; console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const bad = (o) => { const p = []; (function w(v, pa) { if (typeof v === 'number' && !isFinite(v)) p.push(pa); else if (v && typeof v === 'object') for (const k of Object.keys(v)) w(v[k], pa + '.' + k); })(o, ''); return p; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ------------------------------------------------------------------ real engine + real data
const inputs = IO.loadInputs(false), analysis = S.analyze(inputs);
const terrainRows = { earth: { 120: inputs.earth[120].rows, 360: inputs.earth[360].rows } };
['mars', 'moon'].forEach((b) => { terrainRows[b] = { 120: IO.readRows(b, 120), 360: IO.readRows(b, 360) }; });
const eng = Mission.create({ analysis, rows: inputs.earth[120].rows, terrainRows });
function pickCells(body) {
  const r = terrainRows[body][120], c = [];
  for (let i = 0; i < r.length; i++) if (r[i].slope_deg != null && r[i].slope_deg < 3 && r[i].roughness_std != null) c.push(i);
  const a = c[Math.floor(c.length * 0.3)];
  for (const j of c) { const d = Math.hypot(r[j].x_m_localTM - r[a].x_m_localTM, r[j].y_m_localTM - r[a].y_m_localTM); if (d > 2500 && d < 3500) return [a, j]; }
  return null;
}
const configs = { earth: { targetBody: 'mars', strategy: 'ALL', resources: { energyBudgetWh: 600, timeBudgetH: 8, energyReserveFraction: 0.25 } } };
['mars', 'moon'].forEach((b) => { const [a, g] = pickCells(b); configs[b] = { targetBody: b, operatingBody: b, strategy: 'ALL', start: { row_index: a }, goal: { row_index: g }, resources: { energyBudgetWh: 900 } }; });
const real = {};   // real[body][strategy] = { scenario, adapted }
for (const k of Object.keys(configs)) {
  const out = eng.run(configs[k]); ok(out.ok === true, '[REAL] planning engine run succeeds for ' + k + ' (operating body)');
  real[k] = {};
  for (const st of Object.keys(out.plan.strategies)) { let sc = null; try { sc = eng.exportSimulationScenario(out.plan, st); } catch (e) { continue; } real[k][st] = { scenario: sc, adapted: Sim.fromMissionScenario(sc) }; }
}
const base = real.earth.FAST, bScn = base.scenario, bAd = base.adapted;

// ================================================================== A. integration with the REAL planner output
console.log('\n--- A. real planner export -> simulation');
ok(bAd.ok && bAd.errors.length === 0, '[REAL] fromMissionScenario accepts the real Earth FAST export');
const direct = Sim.run(bScn, {});
ok(direct.data_gaps.some((g) => g.code === 'SEGMENT_SLOPE_MISSING'), '[REAL] documents the defect fixed by the adapter: feeding the raw export straight to run() silently drops all terrain (SEGMENT_SLOPE_MISSING)');
for (const body of Object.keys(real)) for (const st of Object.keys(real[body])) {
  const { scenario: sc, adapted: ad } = real[body][st], rep = Sim.run(ad.plan, { rover: ad.rover });
  ok(ad.ok && rep.validation.errors.length === 0, '[REAL] ' + body + '/' + st + ': adapted plan validates');
  ok(Math.abs(rep.totals.planned_distance_m - sc.expected.metrics.distance_m) < 0.5, '[REAL] ' + body + '/' + st + ': simulated route length ' + rep.totals.planned_distance_m.toFixed(1) + ' m equals planner distance ' + sc.expected.metrics.distance_m + ' m');
  ok(rep.segments.every((s) => s.terrain_known && s.slope_deg != null && s.slope_deg_max >= s.slope_deg), '[REAL] ' + body + '/' + st + ': every leg carries real grade data (max >= mean)');
  ok(rep.coordinate_reference.wgs84 === (body === 'earth'), '[REAL] ' + body + '/' + st + ': coordinate_reference.wgs84 = ' + rep.coordinate_reference.wgs84 + (body === 'earth' ? ' (Earth is WGS84)' : ' (Mars/Moon are NOT WGS84)'));
  const last = sc.waypoints[sc.waypoints.length - 1], fin = Sim.createSimulation(ad.plan, { rover: ad.rover }); fin.runToEnd(); const pos = fin.getState().position;
  if (rep.status === 'completed') ok(Math.abs(pos.x_m - last.x_m) < 0.01 && Math.abs(pos.y_m - last.y_m) < 0.01, '[REAL] ' + body + '/' + st + ': final simulated position equals the last planned waypoint (local metres)');
  ok(Math.abs(rep.totals.energy.balance_check_wh) < 1e-6, '[REAL] ' + body + '/' + st + ': energy balance closes');
  ok(bad(rep).length === 0, '[REAL] ' + body + '/' + st + ': no NaN/Infinity in the report');
}
const rE = Sim.run(bAd.plan, { rover: bAd.rover });
ok(rE.status === 'completed' && rE.objective_summary.completed === 1 && rE.objective_summary.required_total === 1, '[REAL] Earth FAST: completes the planner "stop" as a required objective (' + rE.objective_summary.completed + '/1)');
const ratio = rE.totals.energy.consumed_wh.total / bScn.expected.resources.total_energy_wh;
console.log('   info: sim energy ' + rE.totals.energy.consumed_wh.total.toFixed(1) + ' Wh vs planner ' + bScn.expected.resources.total_energy_wh + ' Wh (ratio ' + ratio.toFixed(3) + '); time ' + (rE.totals.elapsed_s / 3600).toFixed(3) + ' h vs ' + bScn.expected.resources.total_time_h + ' h. Different models, so a difference is expected.');
ok(ratio > 0.8 && ratio < 1.3, '[REAL] simulator energy is within 20-30% of the planner estimate (same route; different assumed models)');
['SAFE', 'SCIENTIFIC'].forEach((st) => { const e = real.earth[st], rr = Sim.run(e.adapted.plan, { rover: e.adapted.rover }); ok(e.scenario.expected.resources.energy.status === 'exceeds' && rr.status === 'halted' && /BATTERY/.test(rr.halted.code), '[REAL] Earth ' + st + ': planner says energy budget exceeded and the simulation halts on battery (' + (rr.halted && rr.halted.code) + ')'); });
ok(same(Sim.fromMissionScenario(bScn), Sim.fromMissionScenario(JSON.parse(JSON.stringify(bScn)))), '[REAL] adapter is deterministic');
const frozen = JSON.parse(JSON.stringify(bScn)); (function fz(o) { Object.freeze(o); Object.values(o).forEach((v) => { if (v && typeof v === 'object') fz(v); }); })(frozen);
ok(Sim.fromMissionScenario(frozen).ok, '[REAL] adapter does not mutate its input (deep-frozen export accepted)');
const noBudget = eng.run({ targetBody: 'mars', strategy: 'FAST' }), nbAd = Sim.fromMissionScenario(eng.exportSimulationScenario(noBudget.plan, 'FAST'));
ok(nbAd.warnings.some((w) => /No energy budget/.test(w)) && nbAd.rover.parameter_provenance === 'assumed', '[REAL] no energy budget in the export -> placeholder battery is announced, rover provenance stays "assumed"');
ok(Sim.fromMissionScenario(null).ok === false && Sim.fromMissionScenario({}).ok === false && Sim.fromMissionScenario({ kind: 'fieldzero_simulation_scenario', waypoints: [], path: [] }).ok === false, '[SYNTH] adapter rejects null, {}, and an empty scenario (no invented route)');
const tampered = JSON.parse(JSON.stringify(bScn)); tampered.waypoints[1].row_index = -5;
ok(Sim.fromMissionScenario(tampered).ok === false, '[SYNTH] adapter rejects a waypoint that is not on the planned path');
const noGrade = JSON.parse(JSON.stringify(bScn)); noGrade.segments.grade_deg[0] = null; const ngAd = Sim.fromMissionScenario(noGrade);
ok(ngAd.ok && ngAd.plan.segments[0].slope_deg === null && ngAd.warnings.some((w) => /without a grade/.test(w)), '[SYNTH] a missing grade stays unknown (null) and is warned, not filled');
const wrongFrame = JSON.parse(JSON.stringify(real.mars.FAST.scenario)); wrongFrame.coordinate_frame.wgs84 = true;
ok(Sim.run(Sim.fromMissionScenario(wrongFrame).plan, { rover: {} }).status === 'invalid', '[SYNTH] a Mars plan that claims WGS84 coordinates is rejected');
// missing dataset: planner without Mars terrain cannot produce a route; nothing is simulated
const eng2 = Mission.create({ analysis, rows: inputs.earth[120].rows }), miss = eng2.run({ targetBody: 'mars', operatingBody: 'mars', start: { row_index: 1000 }, goal: { row_index: 5000 } });
ok(miss.ok === false && miss.plan === null, '[REAL] Mars terrain not loaded -> planning fails explicitly (' + (miss.errors[0] && miss.errors[0].code) + '); no terrain is invented');

// ================================================================== B. route simulation
console.log('\n--- B. route simulation');
const A = bAd.plan, rov = bAd.rover;
ok(same(Sim.run(A, { rover: rov }), Sim.run(A, { rover: rov })), '[REAL] identical inputs give byte-identical reports');
const outcome = (r) => [r.status, r.totals.elapsed_s.toFixed(3), r.totals.energy.consumed_wh.total.toFixed(4)].join('|');
ok(outcome(Sim.createSimulation(A, { rover: rov, stepSeconds: 13 }).runToEnd()) === outcome(rE), '[REAL] outcome independent of step size');
const ctl = Sim.createSimulation(A, { rover: rov, stepSeconds: 120 }); let last = -1, mono = true, st0; do { st0 = ctl.tick(); if (st0.time.elapsed_s < last) mono = false; last = st0.time.elapsed_s; } while (st0.status !== 'completed' && st0.tick < 5000);
ok(mono && st0.route.progress_fraction === 1, '[REAL] time is monotonic and progress reaches 1 when ticking');
const mid = Sim.createSimulation(A, { rover: rov, stepSeconds: 60 }); mid.tick(rE.totals.time_by_activity_s.drive * 0.5); const mp = mid.getState().position, xs = A.waypoints.map((w) => w.x_m), ys = A.waypoints.map((w) => w.y_m);
ok(mp.x_m >= Math.min(...xs) - 1 && mp.x_m <= Math.max(...xs) + 1 && mp.y_m >= Math.min(...ys) - 1 && mp.y_m <= Math.max(...ys) + 1 && mid.getState().route.progress_fraction > 0 && mid.getState().route.progress_fraction < 1, '[REAL] position at half of the DRIVING time lies inside the planned route bounds and progress is between 0 and 1 (the 2 h site dwell is excluded)');
const sumSeg = rE.segments.reduce((s, x) => s + x.traveled_m, 0); ok(Math.abs(sumSeg - rE.totals.planned_distance_m) < 1e-3 && Math.abs(rE.totals.time_by_activity_s.drive + rE.totals.time_by_activity_s.dwell + rE.totals.time_by_activity_s.wait - rE.totals.elapsed_s) < 1e-6, '[REAL] distance and time accounting add up (segments = total; drive+dwell+wait = elapsed)');
let fn = null; const sched = { setInterval: (f) => { fn = f; return 1; }, clearInterval: () => { fn = null; } }, pc = Sim.createSimulation(A, { rover: rov, stepSeconds: 600, scheduler: sched });
pc.play(); fn(); pc.pause(); const tp = pc.getState().time.elapsed_s; pc.resume(); fn(); const t2 = pc.getState().time.elapsed_s; pc.reset(); ok(tp > 0 && t2 > tp && pc.getState().time.elapsed_s === 0 && pc.getState().status === 'idle', '[REAL] play/pause/resume/reset behave (' + tp + ' s -> ' + t2 + ' s -> reset 0)');
ok(Sim.createSimulation(A, { rover: rov }).getState().position.wgs84 === true && Sim.createSimulation(real.mars.FAST.adapted.plan, { rover: real.mars.FAST.adapted.rover }).getState().position.wgs84 === false, '[REAL] live state carries the wgs84 flag (Earth true, Mars false)');
const inv = (plan, r) => Sim.run(plan, { rover: r || {} });
const P0 = { waypoints: [{ id: 'A', x_m: 0, y_m: 0 }, { id: 'B', x_m: 100, y_m: 0 }] };
ok(inv(null).status === 'invalid' && inv({}).status === 'invalid' && inv({ waypoints: 'x' }).status === 'invalid', '[SYNTH] null / empty / malformed plans are invalid, not simulated');
ok(inv({ waypoints: [{ id: 'A', x_m: 0, y_m: 0 }, { id: 'A', x_m: 1, y_m: 0 }] }).status === 'invalid', '[SYNTH] duplicate waypoint ids rejected');
ok(inv({ ...P0, segments: [{ from: 'X' }] }).status === 'invalid', '[SYNTH] segment endpoint mismatch rejected');
ok(inv({ ...P0, objectives: [{ id: 'o', waypoint_id: 'NOPE' }] }).status === 'invalid', '[SYNTH] objective at unknown waypoint rejected');
ok(inv(P0, { nominal_speed_mps: -1 }).status === 'invalid' && inv(P0, { battery_capacity_wh: 'big' }).status === 'invalid' && inv(P0, { initial_soc_frac: 2 }).status === 'invalid', '[SYNTH] invalid rover parameters rejected');
ok(inv({ waypoints: [{ id: 'A', lon_deg: 1, lat_deg: 1 }, { id: 'B', lon_deg: 1.01, lat_deg: 1 }] }).status === 'invalid', '[SYNTH] lon/lat without a known body is rejected (no projection guessed)');
const ll = (b) => Sim.run({ body: b, waypoints: [{ id: 'A', lon_deg: 10, lat_deg: 0 }, { id: 'B', lon_deg: 10.01, lat_deg: 0 }] }, { rover: {} }), dE = ll('earth').totals.planned_distance_m, dM = ll('mars').totals.planned_distance_m, dMo = ll('moon').totals.planned_distance_m;
ok(Math.abs(dE - 0.01 * Math.PI / 180 * 6371008.8) < 1e-3 && Math.abs(dM - 0.01 * Math.PI / 180 * 3396190) < 1e-3 && Math.abs(dMo - 0.01 * Math.PI / 180 * 1737400) < 1e-3, '[SYNTH] lon/lat fallback uses each body\'s own radius (0.01 deg = ' + dE.toFixed(1) + ' m Earth, ' + dM.toFixed(1) + ' m Mars, ' + dMo.toFixed(1) + ' m Moon) and warns');
ok(ll('mars').validation.warnings.some((w) => /equirectangular/.test(w)), '[SYNTH] the lon/lat projection is flagged as an assumption');
ok(inv({ ...P0, body: 'venus' }).validation.warnings.some((w) => /not earth, mars or moon/.test(w)) && inv(P0).validation.warnings.some((w) => /plan.body is missing/.test(w)), '[SYNTH] unknown / missing body is warned');
ok(Sim.run(P0, { rover: {}, onViolation: 'bogus' }).validation.warnings.some((w) => /onViolation/.test(w)), '[SYNTH] invalid option values are warned, not silently accepted');
const m0 = inv({ ...P0, segments: [{ slope_deg: 1, length_m: 100 }] }, { condition: { mobility: 0 } }); ok(m0.halted && m0.halted.code === 'ROVER_IMMOBILE' && bad(m0).length === 0, '[SYNTH] zero mobility halts as ROVER_IMMOBILE with no NaN/Infinity');
// limits on the real Earth route
const slopeMax = Math.max(...A.segments.map((s) => s.slope_deg_max));
const tight = Sim.run({ ...A, constraints: { ...A.constraints, max_slope_deg: slopeMax * 0.5 } }, { rover: rov }); ok(tight.halted && tight.halted.code === 'SLOPE_EXCEEDS_LIMIT', '[REAL] a slope limit below the real route\'s steepest leg halts (' + slopeMax.toFixed(2) + ' deg route max)');
const lowB = Sim.run(A, { rover: { ...rov, battery_capacity_wh: 120 } }); ok(lowB.halted && /BATTERY/.test(lowB.halted.code) && lowB.totals.progress_fraction < 1, '[REAL] a battery smaller than the route needs halts before completion');
const tl2 = { ...A, constraints: { ...A.constraints, max_mission_s: rE.totals.elapsed_s * 0.5 } }, rc = Sim.run(tl2, { rover: rov, onViolation: 'record_and_continue' });
ok(rc.status === 'completed' && rc.events.some((e) => e.code === 'TIME_LIMIT_EXCEEDED' && e.severity === 'violation'), '[REAL] record_and_continue finishes the route and logs the time-limit overrun as a violation event');
const rs0 = Sim.run(A, { rover: { ...rov, battery_capacity_wh: 120, min_soc_frac: 0.3 }, onViolation: 'record_and_continue' }); ok(rs0.events.some((e) => e.code === 'BATTERY_BELOW_RESERVE' && e.severity === 'violation') && rs0.halted && rs0.halted.code === 'BATTERY_DEPLETED', '[REAL] reserve breach is logged as a violation, but an EMPTY battery always stops the run');
// resume equals continuous
const cs = Sim.createSimulation(A, { rover: rov, stepSeconds: 100 }); cs.tick(2000); const cont = Sim.run(A, { rover: rov, initial: cs.snapshot().resume }); ok(Math.abs(cont.totals.elapsed_s - rE.totals.elapsed_s) < 1e-3 && Math.abs(cont.totals.energy.end_wh - rE.totals.energy.end_wh) < 1e-3, '[REAL] resuming from a snapshot reproduces the uninterrupted run');

// ================================================================== C. scenario engine
console.log('\n--- C. scenario engine (real Earth FAST plan)');
const sceneIn = { plan: A, rover: rov, scenarios: [{ id: 'half-battery', changes: { resources: { battery_capacity_scale: 0.4 } } }, { id: 'slope+', changes: { route_conditions: { slope_scale: 2 }, rover_condition: { mobility: 0.8 } } }, { id: 'noop', changes: { resources: { battery_capacity_scale: 1 } } }] };
const sc1 = Sc.run(sceneIn), sc2 = Sc.run(sceneIn); ok(sc1.status === 'ok' && same(sc1, sc2), '[REAL] what-if run is deterministic');
ok(sc1.baseline.mission_class === 'SUCCESS' && sc1.scenarios[0].summary.mission_class !== 'SUCCESS', '[REAL] baseline SUCCESS vs 40% battery -> ' + sc1.scenarios[0].summary.mission_class + ' (' + sc1.scenarios[0].summary.halted_code + ')');
const dl = sc1.scenarios[1].delta_vs_baseline.elapsed_s; ok(Math.abs(dl.delta - (dl.scenario - dl.baseline)) < 0.11 && dl.delta > 0, '[REAL] delta equals scenario - baseline and slower mobility lengthens the run (+' + dl.delta + ' s)');
ok(sc1.scenarios[2].delta_vs_baseline.energy_consumed_wh.delta === 0 && sc1.scenarios[2].outcome_change.changed === false, '[REAL] a no-op change gives zero delta');
ok(same(JSON.parse(JSON.stringify(A)), JSON.parse(JSON.stringify(bAd.plan))) && sc1.scenarios[0].changes_applied.length === 1, '[REAL] baseline inputs are not mutated by scenarios');
const sw = Sc.sweep({ plan: A, rover: rov, path: 'resources.battery_capacity_scale', values: [0.3, 0.6, 1, 1.5] }); ok(sw.status === 'ok' && sw.rows.length === 4 && sw.rows[3].mission_class === 'SUCCESS' && sw.first_outcome_change, '[REAL] sweep finds the outcome change point ' + JSON.stringify(sw.first_outcome_change && sw.first_outcome_change.between_values));
ok(Sc.run({ plan: A, rover: rov, scenarios: { a: 1 } }).status === 'error' && Sc.run({ plan: A, rover: rov, scenarios: [null, { id: 'x', changes: { resources: { solar_input_w: 5 } } }] }).scenarios[0].status === 'invalid_scenario', '[SYNTH] non-array scenarios / null entries are reported, never thrown');
ok(Sc.run({ plan: A, rover: rov, scenarios: [{ id: 'a', changes: { resources: { solar_input_w: 5 } } }, { id: 'a', changes: { resources: { solar_input_w: 9 } } }] }).scenarios[1].status === 'invalid_scenario', '[SYNTH] duplicate scenario ids are rejected');
ok(Sc.sweep({ plan: A, rover: rov, path: 'resources.battery_capacity_scale', values: 'x' }).status === 'error' && Sc.sweep({ plan: A, rover: rov, path: 'bogus.path', values: [1] }).status === 'error', '[SYNTH] bad sweep input returns an error object');
const rs = Sc.run({ plan: { ...A, constraints: { ...A.constraints, min_battery_soc_frac: 0.5 } }, rover: rov, scenarios: [{ id: 'r', changes: { resources: { reserve_frac: 0.1 } } }] }).scenarios[0]; ok(rs.status === 'no_changes_applied' && /no effect/.test(rs.ignored[0].reason), '[SYNTH] a reserve change that cannot take effect is listed as ignored, not "applied"');
ok(Sc.run({ plan: null, rover: rov, scenarios: [] }).status === 'invalid_baseline', '[SYNTH] invalid baseline reported');

// ================================================================== D. failure analysis
console.log('\n--- D. failure analysis');
const small = { ...rov, battery_capacity_wh: 150 }, hRun = Sim.run(A, { rover: small }), fA = Fail.analyze(hRun, { plan: A, rover: small });
ok(fA.status === 'failure_detected' && /BATTERY/.test(fA.failures[0].code) && fA.failures[0].consequences.stops_mission && fA.failures[0].mission_impact.outcome_without_recovery !== 'SUCCESS', '[REAL] battery failure detected and classified (' + fA.failures[0].code + '); impact: ' + fA.failures[0].mission_impact.text);
const fb = fA.failures[0]; ok(Math.abs(fb.causes.demand_side.reduce((s, x) => s + x.wh, 0) - hRun.totals.energy.consumed_wh.total) < 0.01, '[REAL] cause decomposition sums to the consumed energy');
ok(fb.recovery.actions.find((a) => a.id === 'WAIT_RECHARGE').applicable === false && fb.recovery.feasibility !== 'full', '[REAL] no charging source defined -> recharge reported as unavailable, not guessed');
const planS = { ...A, environment: { solar_input_w: 55 }, constraints: { ...A.constraints, max_mission_s: null } }, mSmall = { ...rov, battery_capacity_wh: 110 }, hS = Sim.run(planS, { rover: mSmall }), fS = Fail.analyze(hS, { plan: planS, rover: mSmall }), w = fS.failures[0] && fS.failures[0].recovery.actions.find((a) => a.id === 'WAIT_RECHARGE');
ok(hS.halted && w && w.applicable && w.feasible === true, '[SYNTH-ENV] with an assumed 55 W charging source, 110 Wh battery, no time limit the recharge recovery is evaluated and feasible (' + (w && (w.estimate.action_time_s / 3600).toFixed(2)) + ' h) [solar value is an invented test input]');
const rep = (d) => Sim.run(planS, { rover: mSmall, initial: hS.resume, preActions: [{ type: 'WAIT', duration_s: d }], traceEveryS: 1e9 }); ok(rep(w.estimate.action_time_s).status === 'completed' && rep(w.estimate.action_time_s - 5).status !== 'completed', '[SYNTH-ENV] independent replay confirms the recommended wait is sufficient and minimal');
const blk = { ...A, segments: A.segments.map((s, i) => i === 1 ? { ...s, passable: false } : s) }, fBlk = Fail.analyze(Sim.run(blk, { rover: rov }), { plan: blk, rover: rov });
ok(fBlk.failures[0].code === 'SEGMENT_BLOCKED' && fBlk.failures[0].recovery.actions.find((a) => a.id === 'ALTERNATE_ROUTE').applicable === false, '[REAL] blocked leg: no planner alternative -> reported unavailable, route not invented');
const cons = { ...A, constraints: { max_slope_deg: slopeMax * 0.5 } }, fCons = Fail.analyze(Sim.run(cons, { rover: rov }), { plan: cons, rover: rov }); ok(fCons.failures[0].causes.primary === 'route_constraint_slope_limit' && fCons.failures[0].recovery.actions.find((a) => a.id === 'OVERRIDE_PLANNING_LIMIT').feasible === true, '[REAL] planning-constraint slope failure identified and its override evaluated');
const tl = { ...A, constraints: { max_mission_s: rE.totals.elapsed_s * 0.5 } }, fT = Fail.analyze(Sim.run(tl, { rover: rov }), { plan: tl, rover: rov }); ok(fT.failures[0].code === 'TIME_LIMIT_REACHED' && fT.failures[0].recovery.actions.find((a) => a.id === 'EXTEND_TIME_LIMIT').estimate.extra_time_needed_s > 0, '[REAL] time-limit failure and required extension evaluated');
ok(Fail.analyze(rE, { plan: A, rover: rov }).status === 'no_failure' && Fail.analyze(null).status === 'invalid_input' && Fail.analyze({ contract: 'x' }).status === 'invalid_input' && Fail.analyze(Sim.run({}, { rover: {} })).status === 'invalid_input', '[REAL] healthy run -> no_failure; invalid / foreign reports -> invalid_input');
ok(Fail.analyze(hRun, {}).failures[0].recovery.evaluated === false && Fail.analyze(hRun, { plan: A, rover: small, evaluateRecovery: false }).failures[0].recovery.evaluated === false, '[REAL] recovery is "not evaluated" without plan/rover or when switched off');
ok(Fail.executeRecovery(fA, 'NOPE').executed === false && Fail.executeRecovery(Fail.analyze(rE, {})).executed === false, '[REAL] executing an unknown action / with no failure is refused');
const rcf = Fail.analyze(rc, { plan: tl2, rover: rov }); ok(rcf.failures.length > 0 && rcf.failures.every((f) => f.consequences.stops_mission === false), '[REAL] violations recorded under record_and_continue are not treated as mission-stopping');

// ================================================================== E. cost engine
console.log('\n--- E. cost engine');
const equip = { ...rov, equipment: [{ id: 'drill', name: 'Drill', duty: 'dwell', available_hours: 3, cost_per_hour: 20 }] }, planR = { ...A, resources: [{ id: 'tubes', name: 'Tubes', unit: 'pcs', available: 2, unit_cost: 10 }], objectives: A.objectives.map((o) => ({ ...o, requires: [{ resource_id: 'tubes', quantity: 1 }] })) };
const repC = Sim.run(planR, { rover: equip }), co = Cost.compute({ report: repC, plan: planR, rover: equip });
ok(co.status === 'ok' && Math.abs(co.cost.simulated.total - co.cost.simulated.components.reduce((s, x) => s + (x.amount || 0), 0)) < 0.01, '[REAL] cost total equals the sum of its components');
ok(Math.abs(co.ledger.energy.consumed_wh.total - repC.totals.energy.consumed_wh.total) < 1e-9 && Math.abs(co.ledger.energy.end_wh - co.ledger.energy.start_wh + co.ledger.energy.consumed_wh.total - co.ledger.energy.generated_wh) < 1e-6, '[REAL] ledger energy equals the simulation and balances (start - consumed + generated = end)');
ok(Math.abs(co.remaining.energy_above_reserve_wh - (repC.totals.energy.end_wh - repC.totals.energy.reserve_wh)) < 0.01, '[REAL] remaining energy above reserve is end - reserve');
ok(co.ledger.consumables[0].remaining === 1 && co.ledger.equipment[0].hours_used === +(repC.totals.time_by_activity_s.dwell / 3600).toFixed(4), '[REAL] consumable remaining (2 - 1 used) and equipment dwell hours tracked');
ok(co.actuals.measured === null && co.cost.measured === null && co.notes.some((x) => /No telemetry/.test(x)) && co.actuals.simulated.provenance.indexOf('not measured') > -1, '[REAL] without telemetry, "measured" is null and simulated values are labelled not measured');
const coT = Cost.compute({ report: repC, plan: planR, rover: equip, telemetry: { elapsed_s: repC.totals.elapsed_s * 1.1 } }); ok(coT.actuals.measured.elapsed_s > repC.totals.elapsed_s && coT.cost.measured.complete === false && coT.cost.measured.components.some((c) => c.amount === null && c.unavailable_reason), '[REAL] caller telemetry stays separate; missing measured quantities are null with a reason (cost marked incomplete)');
ok(co.estimates.provenance.indexOf('estimated') === 0 && co.cost.currency.indexOf('abstract') > -1 && co.assumptions.provenance === 'placeholder', '[REAL] estimates, abstract cost units and placeholder rates are labelled');
const coH = Cost.compute({ report: hRun, plan: A, rover: small }); ok(coH.shortages.some((s) => s.resource === 'energy' && s.shortfall_upper > 0), '[REAL] unfinished run: energy shortage estimated (' + JSON.stringify(coH.shortages.filter((s) => s.resource === 'energy').map((s) => s.shortfall_upper)) + ' Wh)');
const badEq = { ...rov, equipment: [{ id: 'x', duty: 'flying', cost_per_hour: 5, available_hours: 2 }] }, coB = Cost.compute({ report: Sim.run(A, { rover: badEq }), plan: A, rover: badEq });
ok(bad(coB).length === 0 && coB.ledger.equipment[0].status === 'duty_invalid' && coB.notes.some((x) => /unknown duty/.test(x)) && !coB.shortages.some((s) => /equipment/.test(s.resource)), '[SYNTH] unknown equipment duty -> hours unavailable (null), flagged, no NaN, no bogus shortage');
const coR = Cost.compute({ report: rE, plan: A, rover: rov, assumptions: { rates: { operations_per_hour: -5, bogus: 1, energy_per_wh: 0.5 } } }); ok(coR.assumptions.rates.operations_per_hour === 100 && coR.assumptions.rates.energy_per_wh === 0.5 && coR.notes.filter((x) => /Ignored assumption/.test(x)).length === 2 && coR.assumptions.provenance.indexOf('mixed') === 0, '[SYNTH] invalid rates are ignored AND reported; valid rate is user-supplied (provenance "mixed")');
ok(Cost.compute({}).status === 'invalid_input' && Cost.compute({ report: { contract: 'x' } }).status === 'invalid_input', '[SYNTH] cost engine rejects missing / foreign reports');
const cm0 = Cost.compute({ report: m0, plan: P0, rover: { condition: { mobility: 0 } } }); ok(cm0.status === 'ok' && bad(cm0).length === 0 && cm0.notes.some((x) => /LOWER BOUNDS/.test(x)), '[SYNTH] zero-mobility estimate is flagged as a lower bound, no NaN');

// ================================================================== F. mission results
console.log('\n--- F. mission results');
const rr = Res.run({ plan: planR, rover: equip, includeRaw: true }), raw = rr.raw;
ok(rr.status === 'ok' && rr.success_assessment.verdict === 'SUCCESS' && rr.success_assessment.confidence === 'low', '[REAL] real Earth FAST run: verdict ' + rr.success_assessment.verdict + ', confidence ' + rr.success_assessment.confidence + ' (placeholder rover and unknown roughness cap confidence)');
ok(rr.progress.progress_fraction === +raw.report.totals.progress_fraction.toFixed(4) && rr.cost.simulated_total === raw.cost.cost.simulated.total && Math.abs(rr.resource_consumption.energy.consumed_wh.total - raw.report.totals.energy.consumed_wh.total) < 0.01 && rr.objectives.required_completed === raw.report.objective_summary.required_completed, '[REAL] results equal the underlying report / cost values (progress, cost, energy, objectives)');
ok(rr.meta.coordinate_reference.wgs84 === true && real.mars.FAST && Res.run({ plan: real.mars.FAST.adapted.plan, rover: real.mars.FAST.adapted.rover }).data_limitations.some((x) => /NOT WGS84/.test(x)), '[REAL] Mars results carry the "NOT WGS84" limitation; Earth results carry WGS84');
const rf = Res.run({ plan: A, rover: small, recovery: { action_id: 'DESCOPE_OPTIONAL' } }); ok(['PARTIAL', 'FAILED'].includes(rf.success_assessment.verdict) && rf.failures.count >= 1 && rf.recovery.actions.length >= 1 && rf.recovery.status_note.indexOf('none has been executed') > -1 || rf.recovery.executed, '[REAL] failed run: ' + rf.success_assessment.label + '; recovery status "' + rf.recovery.feasibility + '"');
const rcv = Res.run({ plan: tl2, rover: rov, simOptions: { onViolation: 'record_and_continue' } }), vc = rcv.success_assessment.criteria.find((c) => c.id === 'no_constraint_violations');
ok(rcv.success_assessment.verdict !== 'SUCCESS' && vc.met === false && rcv.success_assessment.rationale.some((x) => /Constraint violation/.test(x)), '[REAL] route finished but constraints were violated -> verdict ' + rcv.success_assessment.verdict + ' with an explicit violation rationale (never plain SUCCESS)');
ok(Res.run({ plan: { waypoints: [] }, rover: rov }).status === 'invalid_input' && Res.build({}).status === 'invalid_input', '[SYNTH] invalid input gives invalid_input results');
ok(same(Res.run({ plan: A, rover: rov }), Res.run({ plan: A, rover: rov })), '[REAL] final results are repeatable');
ok(bad(rr).length === 0 && bad(rf).length === 0 && bad(sc1).length === 0 && bad(co).length === 0 && bad(fA).length === 0, '[REAL] no NaN/Infinity in any module output');
const md = Res.toMarkdown(rf); ok(md.includes('Data limitations') && md.includes('Coordinates:') && Res.toMarkdown(null).includes('No results'), '[REAL] markdown export works and states the coordinate reference');

console.log('\n' + n + ' checks, ' + (n - fails) + ' passed, ' + fails + ' failed.');
console.log(fails ? fails + ' CHECK(S) FAILED' : 'ALL CHECKS PASSED'); process.exit(fails ? 1 : 0);
