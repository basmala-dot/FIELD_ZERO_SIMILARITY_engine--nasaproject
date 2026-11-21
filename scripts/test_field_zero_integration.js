#!/usr/bin/env node
'use strict';
/*
 * FIELD//ZERO end-to-end integration test (TASK 4).
 *
 * Uses the REAL project datasets (website/site_manifest.json -> data-loader.js), the real similarity engine, the real
 * mission-intelligence portfolio, and the real planning / simulation / scenario / failure / cost / results modules,
 * joined only through website/js/mission-integration.js. No fixtures stand in for engine output.
 *
 * Workflow exercised:  configure -> validate -> plan (FAST/SAFE/SCIENTIFIC) -> rehearse -> inject a failure ->
 *                      evaluate recovery -> compare scenarios -> cost/resources -> final dossier.
 * Also: Mars-terrain rehearsal (local metres, not WGS84), script load order, DOM-id audit of index.html.
 *
 * Run from the project root:  node scripts/test_field_zero_integration.js
 */
const fs = require('fs'), path = require('path'), http = require('http');
const ROOT = path.resolve(__dirname, '..'), J = p => path.join(ROOT, 'website', 'js', p);

let pass = 0, fail = 0; const failures = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; failures.push(name); console.log('FAIL  ' + name + (detail !== undefined ? '\n        ' + detail : '')); }
}
const near = (a, b, tol) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= tol;
const finite = v => typeof v === 'number' && isFinite(v);
function section(t) { console.log('\n== ' + t); }
function noBadNumbers(o, p, bad) { // NaN / Infinity / undefined-as-string anywhere in a run
  if (typeof o === 'number') { if (!isFinite(o)) bad.push(p); }
  else if (typeof o === 'string') { if (/\bNaN\b|\bundefined\b|\[object Object\]/.test(o)) bad.push(p + ' = ' + o.slice(0, 60)); }
  else if (Array.isArray(o)) o.forEach((x, i) => noBadNumbers(x, p + '[' + i + ']', bad));
  else if (o && typeof o === 'object') Object.keys(o).forEach(k => { if (k !== 'results') noBadNumbers(o[k], p + '.' + k, bad); });
}

(async () => {
  // ------------------------------------------------------------------ 0. real data
  section('0. Real datasets and engines');
  const D = require(J('data-loader.js')), S = require(J('similarity-engine.js')), I = require(J('mission-intelligence.js'));
  const server = http.createServer((q, s) => { const f = path.join(ROOT, decodeURIComponent(q.url.split('?')[0])); fs.readFile(f, (e, b) => { if (e) { s.statusCode = 404; s.end(); } else s.end(b); }); });
  await new Promise(r => server.listen(0, r));
  const base = 'http://127.0.0.1:' + server.address().port;
  await D.init({ manifestUrl: base + '/website/site_manifest.json' }); await D.loadAll();
  await D.load('earth_120m_terrain_csv'); await D.load('earth_360m_terrain_csv');
  const rows = D.data.terrain.earth[120].csv.rows, analysis = S.analyzeLoaded(D.data);
  ok(rows.length > 10000, 'real Earth 120 m terrain table loaded (' + rows.length + ' rows)');
  ok(analysis.results.mars[120].stats.n_scored > 1000, 'similarity engine scored real Earth cells (' + analysis.results.mars[120].stats.n_scored + ')');
  const portfolio = I.portfolio(analysis, rows, { target: 'mars', n: 5 });
  ok(portfolio.items.length >= 3, 'mission-intelligence produced a real site portfolio (' + portfolio.items.length + ' sites)');

  const INT = require(J('mission-integration.js')), ME = require(J('mission-engine.js'));
  const session = INT.createSession(), api = session.api;
  const ctx = { rows, analysis, data: D.data };

  // ------------------------------------------------------------------ 1. API mismatch is real and resolved
  section('1. Contract-1.0 adapter versus the planner namespace');
  ok(['catalog', 'validate', 'plan', 'run', 'runScenario'].every(k => typeof api[k] === 'function'), 'adapter exposes catalog/validate/plan/run/runScenario');
  ok(typeof ME.run !== 'function' && typeof ME.plan !== 'function' && typeof ME.create === 'function' && typeof ME.fromFZ === 'function', 'FINDING CONFIRMED: planner namespace has create/fromFZ, NOT the contract-1.0 methods (mission-ui could not have worked against it)');
  const cat = api.catalog();
  ok(cat.contract === '1.0' && cat.injections.length >= 3 && cat.recoveries.length >= 5 && cat.triggers.join() === 'time,leg,waypoint', 'catalog lists injections, recoveries and triggers');
  ok(cat.injections.every(i => i.id && i.label && i.description), 'every injection is described');

  // ------------------------------------------------------------------ 2. configure + validate
  section('2. Mission configuration and validation');
  const site = portfolio.items[0];
  const setup = {
    name: 'Integration test mission', objective: { text: 'Characterise a Jezero analog' }, destination: 'mars',
    site: { csv_row_index: site.csv_row_index, lon_deg: site.lon_deg, lat_deg: site.lat_deg },
    vehicle: { name: 'Test rover', mass_kg: 200, max_slope_deg: 20, speed_mps_flat: 0.1, power_w: 60, battery_wh: 6000 },
    equipment: [{ name: 'Drill', mass_kg: 5, power_w: 30 }],
    constraints: { max_cost: 100000, currency: null, max_duration_s: 200 * 3600, min_battery_pct: 20 }, seed: 7
  };
  const v = api.validate(setup);
  ok(v.ok === true && v.errors.length === 0, 'valid setup accepted');
  const bads = {
    'destination earth': Object.assign({}, setup, { destination: 'earth' }),
    'no site': Object.assign({}, setup, { site: null }),
    'negative battery': Object.assign({}, setup, { vehicle: Object.assign({}, setup.vehicle, { battery_wh: -5 }) }),
    'slope 90 deg': Object.assign({}, setup, { vehicle: Object.assign({}, setup.vehicle, { max_slope_deg: 90 }) }),
    'off-Earth without start': Object.assign({}, setup, { route: { body: 'mars', start: null, goal: null } })
  };
  Object.keys(bads).forEach(k => { const r = api.validate(bads[k]); ok(r.ok === false && r.errors.length > 0 && r.errors.every(e => e.message && 'path' in e), 'invalid setup rejected with field-level messages: ' + k + ' -> ' + (r.errors[0] || {}).path); });
  let thrown = null; try { await api.plan(bads['no site'], ctx); } catch (e) { thrown = e; }
  ok(thrown && thrown.code === 'INVALID_SETUP', 'plan() refuses an invalid setup with a typed error');
  thrown = null; try { await api.plan(setup, { rows: null, analysis: null }); } catch (e) { thrown = e; }
  ok(thrown && thrown.code === 'DATA_NOT_READY', 'plan() reports missing data instead of crashing');

  // ------------------------------------------------------------------ 3. planning
  section('3. Planning engine -> three strategies');
  let t0 = Date.now(); const plan = await api.plan(setup, ctx); const planMs = Date.now() - t0;
  const K = ['fast', 'safe', 'scientific'];
  ok(K.every(k => plan.strategies[k].feasible === true), 'FAST, SAFE and SCIENTIFIC all have a feasible route (planning ' + planMs + ' ms)');
  ok(plan.provenance.fixture === false && plan.plan_id && plan.seed_used === 7, 'plan provenance: not a fixture, id and seed echoed');
  ok(K.every(k => plan.strategies[k].summary.success_probability === null), 'no success probability is invented (no engine produces one)');
  ok(K.every(k => plan.strategies[k].summary.risk.level), 'route risk comes from the planner for every strategy');
  const sid = k => session.store.plans[plan.plan_id].enginePlan.strategies[k.toUpperCase()];
  const goalRow = site.csv_row_index;
  ['fast', 'safe'].forEach(k => { const wps = sid(k).route.waypoints, last = wps[wps.length - 1]; ok(last.row_index === goalRow || near(last.lon_deg, rows[goalRow].lon_deg, 0.002), k.toUpperCase() + ' route ends at the selected site (row ' + last.row_index + ' vs ' + goalRow + ')'); });
  ok(plan.assumptions.some(a => /SCIENTIFIC visits/.test(a)), 'documented: SCIENTIFIC visits engine-ranked sites');
  const rec = plan.recommended_strategy; ok(K.indexOf(rec) >= 0, 'planner recommendation passed through: ' + rec);

  // ------------------------------------------------------------------ 4. planning output feeds the simulation
  section('4. Planning outputs -> simulation inputs');
  const P = session.store.plans[plan.plan_id], deps = session.deps;
  K.forEach(k => {
    const sp = INT.buildSimPlan(P.enginePlan, k, setup, P.rows, deps), rt = sid(k).route;
    ok(sp.contract === 'FZ-PLAN-PROVISIONAL-0.1' && sp.body === 'earth', k + ': simulation plan has the provisional contract on Earth');
    ok(sp.waypoints.length === rt.waypoints.length && sp.segments.length === rt.waypoints.length - 1, k + ': one simulation segment per planner waypoint pair');
    const sumLen = sp.segments.reduce((a, g) => a + g.length_m, 0);
    ok(near(sumLen, rt.metrics.distance_m, 1), k + ': segment lengths sum to the planner route distance (' + sumLen.toFixed(1) + ' vs ' + rt.metrics.distance_m + ' m)');
    ok(sp.segments.every(g => g.path.length >= 2 && finite(g.slope_deg) && finite(g.length_m)), k + ': every segment carries a path polyline, slope and length from the planner');
    ok(sp.segments.some(g => finite(g.roughness_std)), k + ': roughness is taken from the terrain table');
    ok(sp.objectives.length === rt.waypoints.filter(w => w.kind === 'stop').length && sp.objectives.every(o => o.dwell_s === P.enginePlan.mission.config.objectives.siteDwellH * 3600), k + ': objectives = planner stops with the configured dwell');
    ok(near(sp.constraints.max_mission_s, setup.constraints.max_duration_s, 1e-6) && near(sp.constraints.min_battery_soc_frac, 0.2, 1e-12) && sp.constraints.max_slope_deg <= 20 + 1e-9, k + ': mission constraints carried (time limit, reserve, slope limit)');
  });
  const rv = INT.roverFromSetup(setup);
  ok(rv.nominal_speed_mps === 0.1 && rv.max_slope_deg === 20 && rv.battery_capacity_wh === 6000 && rv.min_soc_frac === 0.2 && rv.drive_power_w === 60 && rv.equipment.length === 1, 'rover capabilities carried from the builder');
  ok(P.config.rover.massKg === 205 && P.config.rover.basePowerW === 90, 'equipment mass and power added to the planner rover (205 kg, 90 W base load)');

  // ------------------------------------------------------------------ 5. nominal rehearsal for all strategies
  section('5. Virtual rehearsal (nominal) for each strategy');
  const nominal = {};
  for (const k of K) {
    const r = nominal[k] = await api.run(setup, plan.strategies[k], ctx);
    const sm = r.timeline.samples, first = sm[0], last = sm[sm.length - 1], wp0 = r.route.waypoints[0].point, wpN = r.route.waypoints[r.route.waypoints.length - 1].point;
    ok(r.kind === 'nominal' && r.strategy === k && r.provenance.fixture === false, k + ': nominal run object');
    ok(r.map.crs === 'WGS84' && r.map.body === 'earth', k + ': Earth rehearsal is WGS84');
    ok(sm.length > 10 && sm.every((s, i) => i === 0 || s.t_s >= sm[i - 1].t_s) && sm.every(s => finite(s.lon_deg) && finite(s.lat_deg) && finite(s.battery_wh)), k + ': monotonic timeline (' + sm.length + ' samples) with finite positions and battery');
    ok(near(first.x_m, wp0.x_m, 1e-6) && near(first.y_m, wp0.y_m, 1e-6) && near(first.t_s, 0, 1e-9), k + ': simulated rover starts at the planned start');
    ok(r.summary.status === 'completed' ? (near(last.x_m, wpN.x_m, 1e-3) && near(last.y_m, wpN.y_m, 1e-3)) : true, k + ': a completed rehearsal ends at the planned goal');
    ok(sm.every(s => s.lon_deg >= -180 && s.lon_deg <= 180 && s.lat_deg >= -90 && s.lat_deg <= 90), k + ': positions are valid WGS84');
    const lonMin = Math.min.apply(null, rows.map(x => x.lon_deg)), lonMax = Math.max.apply(null, rows.map(x => x.lon_deg)), latMin = Math.min.apply(null, rows.map(x => x.lat_deg)), latMax = Math.max.apply(null, rows.map(x => x.lat_deg));
    ok(sm.every(s => s.lon_deg >= lonMin - 1e-6 && s.lon_deg <= lonMax + 1e-6 && s.lat_deg >= latMin - 1e-6 && s.lat_deg <= latMax + 1e-6), k + ': every simulated position lies inside the real terrain grid');
    ok(near(r.summary.distance_m, sid(k).route.metrics.distance_m, 1), k + ': simulated distance equals the planner route distance (' + r.summary.distance_m + ' m)');
    ok(near(r.results.resource_consumption.energy.balance_check_wh, 0, 1e-6), k + ': energy ledger balances (' + r.results.resource_consumption.energy.balance_check_wh + ' Wh)');
    ok(r.summary.duration_s > 0 && r.summary.energy_used_wh > 0 && r.cost.expected > 0 && r.cost.currency === 'CU', k + ': duration, energy and cost are positive and in CU');
    const bad = []; noBadNumbers(r, 'run', bad); ok(bad.length === 0, k + ': no NaN/undefined values in the run object', bad.slice(0, 3).join('; '));
    ok(r.results.contract === 'FZ-MISSION-RESULTS-0.1' && r.results.success_assessment.label, k + ': mission-results verdict present (' + r.results.success_assessment.label + ')');
    ok(r.limitations.length > 0 && r.assumptions.length > 0, k + ': limitations and assumptions are reported');
  }
  ok(nominal.fast.summary.distance_m < nominal.scientific.summary.distance_m, 'strategies really differ: FAST is shorter than SCIENTIFIC (' + nominal.fast.summary.distance_m + ' vs ' + nominal.scientific.summary.distance_m + ' m)');
  const again = await api.run(setup, plan.strategies.safe, ctx);
  ok(again.summary.duration_s === nominal.safe.summary.duration_s && again.cost.expected === nominal.safe.cost.expected, 'rehearsal is deterministic');
  const comparisonSafe = plan.strategies.safe.summary;
  ok(comparisonSafe.duration_s === nominal.safe.summary.duration_s && comparisonSafe.cost_expected === nominal.safe.cost.expected, 'plan-time strategy card values equal the rehearsal values (same engine, no second source)');

  // ------------------------------------------------------------------ 6. failure injection and recovery
  section('6. What-if: failure interrupts the rehearsal, recovery is evaluated');
  const nom = nominal.safe, legs = nom.route.legs;
  const longLeg = legs.filter(l => l.points.length >= 5)[0];
  ok(!!longLeg, 'SAFE route has a multi-cell leg that a detour can avoid (leg ' + (longLeg && longLeg.id) + ')');
  const mk = (id, over) => Object.assign({ id, name: id, baseline: 'nominal', trigger: { kind: 'leg', leg_id: longLeg.id }, injection: 'segment_blocked', recovery: 'ALTERNATE_ROUTE', probability: null, seed: null }, over || {});
  const detour = await api.runScenario(nom, mk('s-detour'), ctx);
  const f = detour.failures[0];
  ok(detour.kind === 'scenario' && detour.baseline_run_id === nom.run_id && detour.scenario_id === 's-detour', 'scenario run echoes ids');
  ok(detour.summary.status === 'halted' && detour.summary.distance_m < nom.summary.distance_m && detour.summary.duration_s < nom.summary.duration_s, 'the rehearsal is INTERRUPTED before the route end (' + detour.summary.distance_m + ' of ' + nom.summary.distance_m + ' m)');
  ok(f && f.code === 'SEGMENT_BLOCKED' && f.caused_mission_loss === true && f.severity === 'critical', 'failure analysis identifies SEGMENT_BLOCKED as mission-stopping');
  ok(f.root_cause && f.impact && f.component && f.location && finite(f.location.x_m), 'failure has cause, impact, component and simulated location');
  ok(near(detour.scenario_applied.effective_from_t_s, nom.route.waypoints[+longLeg.id - 1].planned_t_s, 1), 'failure strikes at the leg boundary of the baseline timeline (t=' + detour.scenario_applied.effective_from_t_s + ' s)');
  ok(detour.timeline.samples.slice(-1)[0].t_s <= nom.timeline.samples.slice(-1)[0].t_s && detour.timeline.samples.slice(-1)[0].status === 'halted', 'timeline stops at the failure');
  const opts = f.recovery.options, alt = opts.filter(o => o.id === 'ALTERNATE_ROUTE')[0];
  ok(opts.length >= 3 && opts.some(o => o.id === 'ACCEPT_PARTIAL'), 'recovery options evaluated (' + opts.map(o => o.id + ':' + o.feasible).join(', ') + ')');
  ok(alt && alt.feasible === true && alt.chosen === true && alt.outcome && alt.outcome.required_completed === alt.outcome.required_total, 'ALTERNATE_ROUTE: a detour re-planned by the planning engine is feasible and completes the mission');
  ok(f.recovered === true && f.recovery.outcome === 'recovered' && detour.recovery_executed.executed === true, 'chosen recovery executed and reported as recovered');
  ok(detour.summary.open_failures === 0, 'no open failures after recovery');
  const partial = await api.runScenario(nom, mk('s-partial', { recovery: 'ACCEPT_PARTIAL' }), ctx);
  ok(partial.failures[0].recovered === false && partial.summary.open_failures === 1 && partial.outcome !== 'success', 'ACCEPT_PARTIAL leaves the failure open and the mission unfinished (' + partial.outcome_label + ')');
  ok(partial.summary.duration_s === detour.summary.duration_s, 'both scenarios share the same interrupted state (recovery only changes the evaluated continuation)');
  ok(!opts.some(o => o.id === 'WAIT_RECHARGE'), 'recharge is not offered for a blocked leg (not applicable)');
  // single-cell leg: planner cannot detour, and says so
  const shortLeg = legs.filter(l => l.points.length === 2)[0];
  if (shortLeg) {
    const sh = await api.runScenario(nom, mk('s-short', { trigger: { kind: 'leg', leg_id: shortLeg.id } }), ctx);
    ok(sh.failures[0].recovered === false && sh.limitations.some(x => /single cell step/.test(x)), 'one-cell leg: no detour invented, limitation reported');
  }
  // other injections
  const slow = await api.runScenario(nom, { id: 's-slow', name: 'slow', baseline: 'nominal', trigger: { kind: 'leg', leg_id: '3' }, injection: 'traction_loss', recovery: 'ACCEPT_PARTIAL', magnitude: 0.5 }, ctx);
  ok(slow.summary.status === 'completed' && slow.summary.duration_s > nom.summary.duration_s && slow.summary.energy_used_wh > nom.summary.energy_used_wh, 'traction loss: same route, longer time and more energy (' + (slow.summary.duration_s / 3600).toFixed(2) + ' h vs ' + (nom.summary.duration_s / 3600).toFixed(2) + ' h)');
  ok(slow.cost.expected > nom.cost.expected, 'traction loss: cost engine reports higher cost');
  const early = await api.runScenario(nom, { id: 's-early', name: 'early', baseline: 'nominal', trigger: { kind: 'leg', leg_id: '1' }, injection: 'traction_loss', recovery: 'ACCEPT_PARTIAL', magnitude: 0.5 }, ctx);
  ok(early.scenario_explanation && early.scenario_explanation.explanation.length > 0, 'whole-route scenario also carries the scenario engine explanation');
  const direct = deps.scenario.run({ plan: session.store.runs[nom.run_id].simPlan, rover: session.store.runs[nom.run_id].rover, scenarios: [{ id: 'x', changes: { route_conditions: { traction_speed_factor: 0.5 } } }], options: { evaluateRecovery: false }, deps: { simulation: deps.sim } }).scenarios[0].summary;
  ok(near(early.summary.duration_s, direct.elapsed_s, 0.1), 'leg-1 trigger equals the scenario engine whole-route result (' + early.summary.duration_s + ' vs ' + direct.elapsed_s + ' s)');
  const steep = await api.runScenario(nom, { id: 's-steep', name: 'steep', baseline: 'nominal', trigger: { kind: 'waypoint', waypoint_id: 'wp2' }, injection: 'steeper_terrain', recovery: 'OVERRIDE_PLANNING_LIMIT', magnitude: 30 }, ctx);
  ok(steep.failures.length >= 1 && steep.failures[0].code === 'SLOPE_EXCEEDS_LIMIT', 'steeper terrain: slope limit failure detected (' + (steep.failures[0] || {}).code + ')');
  ok(steep.failures[0].recovery.options.some(o => o.id === 'OVERRIDE_PLANNING_LIMIT'), 'steeper terrain: relaxation of planning limit evaluated');
  const timeTrig = await api.runScenario(nom, { id: 's-time', name: 'time', baseline: 'nominal', trigger: { kind: 'time', time_s: nom.summary.duration_s * 0.4 }, injection: 'segment_blocked', recovery: 'ALTERNATE_ROUTE' }, ctx);
  ok(timeTrig.scenario_applied.effective_from_t_s <= nom.summary.duration_s * 0.4 + 1e-6, 'time trigger resolves to the leg active at that time (leg ' + timeTrig.scenario_applied.effective_from_leg + ')');
  const p0 = await api.runScenario(nom, mk('s-p0', { probability: 0, seed: 3 }), ctx), p1 = await api.runScenario(nom, mk('s-p1', { probability: 1, seed: 3 }), ctx);
  ok(p0.scenario_applied.occurred === false && p0.summary.status === 'completed' && p0.failures.length === 0, 'probability 0: event does not occur, run equals baseline (seeded draw ' + p0.scenario_applied.draw + ')');
  ok(p1.scenario_applied.occurred === true && p1.summary.status === 'halted', 'probability 1: event occurs');
  const rerun = await api.runScenario(nom, mk('s-p1b', { probability: 0.5, seed: 11 }), ctx), rerun2 = await api.runScenario(nom, mk('s-p1c', { probability: 0.5, seed: 11 }), ctx);
  ok(rerun.scenario_applied.occurred === rerun2.scenario_applied.occurred && rerun.scenario_applied.draw === rerun2.scenario_applied.draw, 'same seed gives the same draw');
  const bt = [['bad leg', { trigger: { kind: 'leg', leg_id: '999' } }], ['bad waypoint', { trigger: { kind: 'waypoint', waypoint_id: 'nope' } }], ['time after end', { trigger: { kind: 'time', time_s: nom.summary.duration_s * 5 } }], ['bad injection', { injection: 'meteor' }], ['bad recovery', { recovery: 'pray' }], ['bad magnitude', { injection: 'traction_loss', magnitude: 7 }]];
  for (const [n, o] of bt) { let e = null; try { await api.runScenario(nom, mk('s-bad', o), ctx); } catch (x) { e = x; } ok(e && e.code && e.message, 'invalid scenario handled with a typed error: ' + n + ' -> ' + (e && e.code)); }
  let e2 = null; try { await api.runScenario({ run_id: 'nope' }, mk('s-x'), ctx); } catch (x) { e2 = x; } ok(e2 && e2.code === 'RUN_NOT_FOUND', 'unknown baseline run handled');

  // ------------------------------------------------------------------ 7. cost and resources
  section('7. Cost and resource tracking');
  const c = nom.cost;
  ok(c.breakdown.length >= 4 && c.breakdown.every(b => finite(b.simulated) && finite(b.estimated)), 'cost breakdown has estimated and simulated amounts per line');
  ok(near(c.breakdown.reduce((a, b) => a + b.simulated, 0), c.simulated, 0.01), 'breakdown sums to the simulated total');
  ok(c.energy.reserve_ok === true && near(c.energy.margin_wh, nom.results.resource_consumption.energy.lowest_wh - nom.results.resource_consumption.energy.reserve_wh, 0.01), 'energy margin = lowest battery level minus reserve');
  ok(c.equipment.listed === 1 && c.equipment.used.indexOf('Drill') >= 0, 'equipment hours tracked (Drill used during site work)');
  ok(c.within_budget === true && c.duration.within_limit === true, 'budget and time-limit checks');
  const budgetCur = await api.run(Object.assign({}, setup, { constraints: Object.assign({}, setup.constraints, { currency: 'EUR' }) }), plan.strategies.safe, ctx).catch(e => e);
  ok(budgetCur instanceof Error && budgetCur.code === 'PLAN_NOT_FOUND', 'run() requires a plan for exactly that setup (no stale plans)');
  const res = nom.resources; ok(res.series.length === 2 && res.series[0].values.length === res.t_s.length && res.thresholds[0].value === nom.results.resource_consumption.energy.reserve_wh, 'resource series align with the timeline; reserve threshold from the ledger');
  const tight = Object.assign({}, setup, { vehicle: Object.assign({}, setup.vehicle, { battery_wh: 1500 }), constraints: Object.assign({}, setup.constraints, { min_battery_pct: 40 }) });
  const planT = await api.plan(tight, ctx).catch(e => e);
  if (planT instanceof Error) ok(true, 'tight battery: planning refused with a message (' + planT.message.slice(0, 60) + ')');
  else {
    const sci = planT.strategies.scientific;
    if (sci.feasible) {
      const rt = await api.run(tight, sci, ctx), bf = rt.failures[0];
      ok(bf && bf.code.indexOf('BATTERY') === 0 && rt.cost.energy.reserve_ok === false && rt.summary.status === 'halted', 'tight battery: SCIENTIFIC rehearsal stops on a battery failure (' + (bf || {}).code + '), reserve reported as violated');
      const wopt = bf.recovery.options.filter(o => o.id === 'WAIT_RECHARGE')[0];
      ok(!wopt || (wopt.feasible === false && /charg/i.test(wopt.feasibility_reason)), 'battery failure: WAIT_RECHARGE is honestly infeasible (no charging source in the data)');
      ok(bf.recovery.options.length >= 1 && bf.impact && bf.root_cause, 'battery failure: cause, impact and recovery options reported');
    }
    else ok(true, 'tight battery: SCIENTIFIC reported infeasible: ' + sci.infeasible_reason.slice(0, 60));
  }

  // ------------------------------------------------------------------ 8. Mars terrain: local metres, never WGS84
  section('8. Rehearsal on Mars terrain (local metres)');
  await D.load('mars_120m_terrain_csv');
  const mrows = D.data.terrain.mars[120].csv.rows;
  const good = mrows.filter(r => r.slope_deg != null && r.slope_deg < 4 && r.roughness_std != null);
  const startRow = good[Math.floor(good.length / 2)];
  const goals = good.filter(g => { const d = Math.hypot(g.x_m_localTM - startRow.x_m_localTM, g.y_m_localTM - startRow.y_m_localTM); return d > 500 && d < 2000; });
  let marsPlan = null, marsSetup = null, tried = 0;
  for (let i = 0; i < goals.length && !marsPlan && tried < 25; i += Math.max(1, Math.floor(goals.length / 25))) {
    const g = goals[i]; tried++;
    const s = Object.assign({}, setup, { site: null, route: { body: 'mars', start: { x_m: startRow.x_m_localTM, y_m: startRow.y_m_localTM }, goal: { x_m: g.x_m_localTM, y_m: g.y_m_localTM } } });
    try { const p = await api.plan(s, ctx); if (p.strategies.safe.feasible) { marsPlan = p; marsSetup = s; } } catch (e) { /* try the next goal */ }
  }
  ok(!!marsPlan, 'a real Mars route was planned from real Mars terrain cells (' + tried + ' goals tried)');
  if (marsPlan) {
    const mr = await api.run(marsSetup, marsPlan.strategies.safe, ctx);
    ok(mr.map.crs === 'local_m' && mr.map.body === 'mars' && /not WGS84/.test(mr.map.frame), 'Mars run declares local_m, frame text says not WGS84');
    const xs = mrows.map(r => r.x_m_localTM), ys = mrows.map(r => r.y_m_localTM), sm = mr.timeline.samples;
    ok(sm.every(s => s.x_m >= Math.min.apply(null, xs) && s.x_m <= Math.max.apply(null, xs) && s.y_m >= Math.min.apply(null, ys) && s.y_m <= Math.max.apply(null, ys)), 'every Mars position lies inside the real Mars x/y grid');
    ok(near(sm[0].x_m, marsSetup.route.start.x_m, 130) && near(sm[0].y_m, marsSetup.route.start.y_m, 130), 'Mars rover starts at the requested start (snapped to a grid cell)');
    ok(mr.route.legs.every(l => l.points.every(p => finite(p.x_m) && finite(p.y_m))), 'Mars legs carry x/y metres for plotting');
    ok(mr.summary.status === 'completed' || mr.failures.length > 0, 'Mars rehearsal ends in a completed run or an analysed failure');
    ok(mr.summary.distance_m > 0 && mr.cost.expected > 0, 'Mars rehearsal produced distance and cost');
  }
  await D.load('moon_120m_terrain_csv');
  const lrows = D.data.terrain.moon[120].csv.rows, lgood = lrows.filter(r => r.slope_deg != null && r.slope_deg < 4 && r.roughness_std != null), ls = lgood[Math.floor(lgood.length / 2)];
  const lgoals = lgood.filter(g => { const d = Math.hypot(g.x_m_localTM - ls.x_m_localTM, g.y_m_localTM - ls.y_m_localTM); return d > 500 && d < 2000; });
  let moonRun = null;
  for (let i = 0; i < lgoals.length && !moonRun; i += Math.max(1, Math.floor(lgoals.length / 10))) {
    const s = Object.assign({}, setup, { destination: 'moon', site: null, route: { body: 'moon', start: { x_m: ls.x_m_localTM, y_m: ls.y_m_localTM }, goal: { x_m: lgoals[i].x_m_localTM, y_m: lgoals[i].y_m_localTM } } });
    try { const p = await api.plan(s, ctx); if (p.strategies.safe.feasible) moonRun = await api.run(s, p.strategies.safe, ctx); } catch (e) { /* next goal */ }
  }
  ok(moonRun && moonRun.map.crs === 'local_m' && moonRun.map.body === 'moon' && /not WGS84/.test(moonRun.map.frame) && moonRun.timeline.samples.every(x => finite(x.x_m) && finite(x.y_m)), 'Moon rehearsal on real Moon terrain is local_m, never WGS84');
  const moonBad = api.validate(Object.assign({}, setup, { destination: 'moon', route: { body: 'mars', start: { x_m: 0, y_m: 0 }, goal: { x_m: 1, y_m: 1 } } }));
  ok(moonBad.ok === false && moonBad.errors.some(e => e.path === 'route.body'), 'Moon destination with Mars rehearsal terrain is rejected');

  // ------------------------------------------------------------------ 9. dossier
  section('9. Final mission dossier');
  const state = { plan, runs: {}, nominal_run_id: nom.run_id, scenarios: [] };
  [nom, detour, partial, slow].forEach(r => { state.runs[r.run_id] = r; });
  [detour, partial, slow].forEach(r => state.scenarios.push({ name: r.scenario_id, run_id: r.run_id, scenario: { injection: r.kind === 'scenario' ? (r.failures[0] ? 'segment_blocked' : 'traction_loss') : '', recovery: r.policy } }));
  const md = api.exportMarkdown(state);
  ok(/# FIELD\/\/ZERO mission results/.test(md) && /## Strategy comparison/.test(md) && /## What-if scenarios/.test(md) && /## Provenance/.test(md), 'dossier markdown has verdict, strategy comparison, what-if table and provenance');
  ok(/FAST:/.test(md) && /SAFE:/.test(md) && /SCIENTIFIC:/.test(md) && /planner estimate/.test(md), 'dossier lists all strategies and the planner-versus-simulation estimates');
  ok(/no telemetry or measured values/i.test(md) && !/NaN|undefined/.test(md), 'dossier states that nothing is measured and contains no NaN/undefined');
  ok(api.exportMarkdown({ runs: {}, nominal_run_id: null }) === null, 'dossier export with no run returns null (UI shows a message)');
  ok(JSON.stringify({ plan: Object.keys(plan.strategies), run: nom }).length > 1000, 'run objects serialise to JSON for the result export');

  // ------------------------------------------------------------------ 10. page wiring (static)
  section('10. index.html wiring');
  const html = fs.readFileSync(path.join(ROOT, 'website', 'index.html'), 'utf8');
  const srcs = [...html.matchAll(/<script src="(js\/[^"]+)"/g)].map(m => m[1]);
  const idx = n => srcs.indexOf('js/' + n + '.js');
  const order = [['data-loader', 'similarity-engine'], ['similarity-engine', 'mission-intelligence'], ['mission-model', 'mission-engine'], ['mission-engine', 'mission-integration'], ['route-simulation', 'scenario-engine'], ['route-simulation', 'failure-analysis'], ['route-simulation', 'cost-engine'], ['failure-analysis', 'mission-results'], ['cost-engine', 'mission-results'], ['route-simulation', 'mission-integration'], ['scenario-engine', 'mission-integration'], ['mission-results', 'mission-integration'], ['mission-integration', 'mission-ui'], ['app', 'mission-ui']];
  order.forEach(([a, b]) => ok(idx(a) >= 0 && idx(b) >= 0 && idx(a) < idx(b), 'script order: ' + a + ' before ' + b));
  ['mission-ui', 'mission-integration', 'route-simulation', 'scenario-engine', 'failure-analysis', 'cost-engine', 'mission-results', 'mission-model', 'mission-engine'].forEach(n => ok(srcs.filter(s => s === 'js/' + n + '.js').length === 1, n + '.js is loaded exactly once'));
  ok(html.indexOf('js/mission-ui.js') > html.indexOf('id="fz-shell-js"'), 'mission-ui.js loads after the inline shell it talks to');
  const ui = fs.readFileSync(J('mission-ui.js'), 'utf8');
  const have = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  [...ui.matchAll(/\bid:\s*'([^']+)'/g)].forEach(m => have.add(m[1]));
  const want = new Set([...ui.matchAll(/\$\('([a-z0-9-]+)'\)/g)].map(m => m[1]));
  const dyn = ['st-', 'fa-', 'cr-', 'wi-', 'rh-', 'dos-', 'm-', 'mb-'];
  const missing = [...want].filter(id => !have.has(id));
  ok(missing.length === 0, 'every element id used by mission-ui.js exists in index.html or is created by it', missing.join(', '));
  ok(!/FieldZeroMission\b/.test(ui.replace(/\/\*[\s\S]*?\*\//, '').replace(/\/\/.*$/gm, '').replace(/NOT contract 1.0[^\n]*/g, '').replace(/window\.FieldZeroMission[^\n]*/g, '')) , 'mission-ui.js does not call the planner namespace directly');

  server.close();
  console.log('\n' + '='.repeat(60) + '\nPASSED ' + pass + '   FAILED ' + fail);
  if (fail) { console.log('Failed checks:\n - ' + failures.join('\n - ')); process.exit(1); }
})().catch(e => { console.error('TEST CRASHED:', e); process.exit(2); });
