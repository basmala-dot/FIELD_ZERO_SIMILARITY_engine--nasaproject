/*! FIELD//ZERO cost and resource engine v0.1.0
 *
 *  RESOURCE LEDGER + TRANSPARENT COST MODEL. COST NUMBERS ARE ABSTRACT UNITS, NOT MONEY, UNLESS THE CALLER SUPPLIES RATES.
 *
 *  Keeps three kinds of numbers strictly apart (every number carries one of these provenance tags):
 *    'estimated'  pre-run analytic estimate from the plan + assumed rover model (FieldZeroSim.estimatePlan)
 *    'simulated'  accumulated by the simulation run (FieldZeroSim report). This is NOT a physical measurement.
 *    'measured'   real telemetry the caller passes in `telemetry`. This project contains none, so it is null unless supplied.
 *  Rates are 'placeholder' (invented defaults below, calibrated to nothing) or 'user-supplied'.
 *
 *  Pure computation (browser + Node 18+), deterministic, never mutates inputs.
 *
 *  ======================================================================================
 *  INPUT   compute({ report, plan, rover, assumptions?, telemetry?, deps? })
 *    report      FZ-SIM-REPORT-0.1 (required for actual/simulated numbers)
 *    plan        optional, FZ-PLAN-PROVISIONAL-0.1: plan.resources [{id,name,unit,available,unit_cost?}], objectives[].requires,
 *                needed for consumables and for the pre-run estimate (via FieldZeroSim, or pass `estimate` directly)
 *    rover       optional; rover.equipment [{id,name,duty:'drive'|'dwell'|'wait'|'always', available_hours?, cost_per_hour?}]
 *    assumptions optional { currency?, rates: { operations_per_hour, energy_per_wh, mobility_wear_per_km, battery_cycle_cost } }
 *    telemetry   optional REAL measurements { elapsed_s?, distance_m?, energy_consumed_wh?, battery_net_discharge_wh?,
 *                equipment_hours?: {id: hours}, consumables_used?: {id: qty} }
 *    estimate    optional precomputed FieldZeroSim.estimatePlan(...).estimate (overrides the dependency call)
 *  OUTPUT  "FZ-COST-0.1" { ledger, estimates, actuals, variance, remaining, shortages, cost, assumptions, notes, limitations }
 *
 *  FORMULAS (each component also prints its own formula)
 *    operations   = hours * operations_per_hour
 *    energy       = energy_consumed_Wh * energy_per_wh
 *    mobility     = distance_km * mobility_wear_per_km
 *    battery_wear = equivalent_full_cycles * battery_cycle_cost,   EFC = net_battery_discharge_Wh / usable_capacity_Wh
 *                   net discharge = max(0, E_start - E_end) (simulated); max(0, energy - solar_credit_upper_bound) (estimated, a lower bound)
 *    equipment    = hours_used(duty) * cost_per_hour
 *    consumables  = quantity_used * unit_cost
 *  Shortage of energy for an unfinished mission = remaining_route_energy - (E_end - reserve). Without a charging model the
 *  solar credit is unknown, so a range [lower, upper] is given: lower subtracts the (constant) solar credit upper bound.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.FieldZeroCost = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function (root) {
  'use strict';

  var VERSION = '0.1.0', CONTRACT = 'FZ-COST-0.1';
  var DEFAULT_ASSUMPTIONS = {
    currency: 'CU (abstract cost units; not money, not calibrated to any real programme)',
    rates: { operations_per_hour: 100, energy_per_wh: 0.02, mobility_wear_per_km: 50, battery_cycle_cost: 400 },
    provenance: 'placeholder'
  };
  var RATE_UNITS = { operations_per_hour: 'CU/h', energy_per_wh: 'CU/Wh', mobility_wear_per_km: 'CU/km', battery_cycle_cost: 'CU/equivalent full cycle' };
  var LIMITATIONS = [
    'Default cost rates are placeholders; totals are for comparing scenarios under stated assumptions, not budget forecasts.',
    '"Simulated" values come from the assumed rover model; only values passed in as telemetry are "measured".',
    'Battery wear uses net depth of discharge only; micro-cycling, temperature and calendar ageing are not modelled.',
    'Equipment and consumable tracking only covers items declared in rover.equipment, plan.resources and objective.requires.',
    'Energy shortage ranges depend on whether a charging source was defined; without one the upper bound is the shortage.'
  ];

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function rd(v, d) { if (!isNum(v)) return v; var k = Math.pow(10, d == null ? 3 : d); return Math.round(v * k) / k; }
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function dep(ctx, key, g, file) {
    if (ctx && ctx.deps && ctx.deps[key]) return ctx.deps[key];
    if (root && root[g]) return root[g];
    if (typeof require === 'function') { try { return require(file); } catch (e) { /* not available */ } }
    return null;
  }

  function resolveAssumptions(user) {
    var a = clone(DEFAULT_ASSUMPTIONS), rateProv = {}, any = false;
    Object.keys(a.rates).forEach(function (k) { rateProv[k] = 'placeholder'; });
    if (user && user.currency) a.currency = user.currency;
    if (user && user.rates) Object.keys(user.rates).forEach(function (k) {
      if (a.rates[k] === undefined) return;
      if (isNum(user.rates[k]) && user.rates[k] >= 0) { a.rates[k] = user.rates[k]; rateProv[k] = 'user-supplied'; any = true; }
    });
    a.rate_provenance = rateProv; a.rate_units = RATE_UNITS;
    a.provenance = any ? (Object.keys(rateProv).every(function (k) { return rateProv[k] === 'user-supplied'; }) ? 'user-supplied' : 'mixed (some placeholder)') : 'placeholder';
    return a;
  }

  // quantities: the physical amounts a cost is computed from. null = not available (never guessed).
  function qFromReport(report) {
    var T = report.totals, E = T.energy, act = T.time_by_activity_s;
    return { source: 'simulated', elapsed_s: T.run_elapsed_s, distance_m: T.distance_travelled_this_run_m, energy_wh: E.consumed_wh.total,
      net_discharge_wh: Math.max(0, E.start_wh - E.end_wh), usable_wh: E.usable_capacity_wh, by_activity_s: { drive: act.drive, dwell: act.dwell, wait: act.wait, always: T.run_elapsed_s } };
  }
  function qFromEstimate(est, usable) {
    return { source: 'estimated', elapsed_s: est.time_s, distance_m: est.distance_m, energy_wh: est.energy_wh, net_discharge_wh: Math.max(0, est.energy_wh - est.solar_credit_upper_bound_wh), usable_wh: usable,
      by_activity_s: { drive: est.drive.time_s, dwell: est.dwell.time_s, wait: 0, always: est.time_s }, lower_bound_note: 'net discharge is a lower bound (assumes the full constant solar credit is usable)' };
  }
  function qFromTelemetry(t, usable) {
    var q = { source: 'measured', elapsed_s: isNum(t.elapsed_s) ? t.elapsed_s : null, distance_m: isNum(t.distance_m) ? t.distance_m : null, energy_wh: isNum(t.energy_consumed_wh) ? t.energy_consumed_wh : null,
      net_discharge_wh: isNum(t.battery_net_discharge_wh) ? t.battery_net_discharge_wh : null, usable_wh: usable, by_activity_s: {}, equipment_hours: t.equipment_hours || {}, consumables_used: t.consumables_used || {} };
    return q;
  }

  function components(q, A, rover, plan, usedConsumables) {
    var r = A.rates, rp = A.rate_provenance, out = [];
    function add(id, label, qty, unit, rate, rateUnit, rateProv, formula, amount, why) {
      out.push({ id: id, label: label, quantity: qty == null ? null : rd(qty, 4), unit: unit, rate: rate, rate_unit: rateUnit, rate_provenance: rateProv, formula: formula,
        amount: amount == null ? null : rd(amount, 3), unavailable_reason: amount == null ? (why || 'quantity not available') : null, quantity_provenance: q.source });
    }
    var h = q.elapsed_s != null ? q.elapsed_s / 3600 : null;
    add('operations', 'Mission operations time', h, 'h', r.operations_per_hour, RATE_UNITS.operations_per_hour, rp.operations_per_hour, 'hours x operations_per_hour', h == null ? null : h * r.operations_per_hour, 'elapsed time not available');
    add('energy', 'Energy consumed', q.energy_wh, 'Wh', r.energy_per_wh, RATE_UNITS.energy_per_wh, rp.energy_per_wh, 'energy_consumed_Wh x energy_per_wh', q.energy_wh == null ? null : q.energy_wh * r.energy_per_wh, 'energy not available');
    var km = q.distance_m != null ? q.distance_m / 1000 : null;
    add('mobility', 'Mobility wear', km, 'km', r.mobility_wear_per_km, RATE_UNITS.mobility_wear_per_km, rp.mobility_wear_per_km, 'distance_km x mobility_wear_per_km', km == null ? null : km * r.mobility_wear_per_km, 'distance not available');
    var efc = (q.net_discharge_wh != null && q.usable_wh > 0) ? q.net_discharge_wh / q.usable_wh : null;
    add('battery_wear', 'Battery wear', efc, 'equivalent full cycles', r.battery_cycle_cost, RATE_UNITS.battery_cycle_cost, rp.battery_cycle_cost, 'net_discharge_Wh / usable_Wh x battery_cycle_cost', efc == null ? null : efc * r.battery_cycle_cost, 'net battery discharge not available');
    ((rover && rover.equipment) || []).forEach(function (eq) {
      if (!isNum(eq.cost_per_hour)) return;
      var hrs = q.source === 'measured' ? (isNum(q.equipment_hours[eq.id]) ? q.equipment_hours[eq.id] : null) : (q.by_activity_s[eq.duty || 'always'] != null ? q.by_activity_s[eq.duty || 'always'] / 3600 : null);
      add('equipment:' + eq.id, 'Equipment: ' + (eq.name || eq.id), hrs, 'h', eq.cost_per_hour, 'CU/h', 'user-supplied', 'hours_used(' + (eq.duty || 'always') + ') x cost_per_hour', hrs == null ? null : hrs * eq.cost_per_hour, 'no hours available');
    });
    ((plan && plan.resources) || []).forEach(function (rs) {
      if (!isNum(rs.unit_cost)) return;
      var used = usedConsumables[q.source] ? usedConsumables[q.source][rs.id] : null;
      add('consumable:' + rs.id, 'Consumable: ' + (rs.name || rs.id), used == null ? null : used, rs.unit || 'units', rs.unit_cost, 'CU/' + (rs.unit || 'unit'), 'user-supplied', 'quantity_used x unit_cost', used == null ? null : used * rs.unit_cost, 'usage not available');
    });
    var total = 0, missing = 0; out.forEach(function (c) { if (c.amount == null) missing++; else total += c.amount; });
    return { components: out, total: rd(total, 3), complete: missing === 0, missing_components: missing, source: q.source };
  }

  function consumablesFromObjectives(objs, statusWanted) {
    var used = {}; (objs || []).forEach(function (o) { if (statusWanted(o)) (o.requires || []).forEach(function (rq) { if (isNum(rq.quantity)) used[rq.resource_id] = (used[rq.resource_id] || 0) + rq.quantity; }); }); return used;
  }

  function compute(input) {
    input = input || {};
    var report = input.report, plan = input.plan || null, rover = input.rover || (report && report.rover) || null, A = resolveAssumptions(input.assumptions);
    var notes = [], tele = input.telemetry || null;
    if (!report || report.contract !== 'FZ-SIM-REPORT-0.1') return { contract: CONTRACT, version: VERSION, status: 'invalid_input', error: 'report (FZ-SIM-REPORT-0.1) is required.', limitations: LIMITATIONS.slice() };
    if (report.validation && report.validation.errors.length) return { contract: CONTRACT, version: VERSION, status: 'invalid_input', error: 'Simulation input was invalid: ' + report.validation.errors.join('; '), limitations: LIMITATIONS.slice() };
    var Sim = dep(input, 'simulation', 'FieldZeroSim', './route-simulation.js');
    var E = report.totals.energy, usable = E.usable_capacity_wh, T = report.totals;

    // ---- ledger (simulated) -------------------------------------------------------------
    var qSim = qFromReport(report);
    var planObjs = plan && Array.isArray(plan.objectives) ? plan.objectives : [];
    var objStatus = {}; report.objectives.forEach(function (o) { objStatus[o.id] = o.status; });
    var usedSim = consumablesFromObjectives(report.objectives, function (o) { return o.status === 'completed'; });
    var equipment = ((rover && rover.equipment) || []).map(function (eq) {
      var duty = eq.duty || 'always', hrs = qSim.by_activity_s[duty] / 3600, av = isNum(eq.available_hours) ? eq.available_hours : null;
      return { id: eq.id, name: eq.name || eq.id, duty: duty, hours_used: rd(hrs, 4), available_hours: av, remaining_hours: av == null ? null : rd(av - hrs, 4), status: av == null ? 'availability_unknown' : (av - hrs < 0 ? 'exhausted' : 'ok'), provenance: 'simulated' };
    });
    var inventory = ((plan && plan.resources) || []).map(function (rs) {
      var used = usedSim[rs.id] || 0, av = isNum(rs.available) ? rs.available : null;
      var planned = consumablesFromObjectives(planObjs, function () { return true; })[rs.id] || 0;
      return { id: rs.id, name: rs.name || rs.id, unit: rs.unit || null, available: av, used: used, remaining: av == null ? null : rd(av - used, 4), planned_total_need: planned, status: av == null ? 'availability_unknown' : (av - used < 0 ? 'exhausted' : 'ok'), provenance: 'simulated (from completed objectives)' };
    });
    var ledger = {
      energy: { start_wh: E.start_wh, end_wh: E.end_wh, min_wh: E.min_wh, reserve_wh: E.reserve_wh, usable_capacity_wh: usable, nameplate_capacity_wh: E.nameplate_capacity_wh, consumed_wh: E.consumed_wh, generated_wh: E.generated_wh, curtailed_wh: E.curtailed_wh,
        soc_start: usable > 0 ? E.start_wh / usable : null, soc_end: usable > 0 ? E.end_wh / usable : null, net_discharge_wh: qSim.net_discharge_wh, equivalent_full_cycles: usable > 0 ? qSim.net_discharge_wh / usable : null,
        share_by_activity: E.consumed_wh.total > 0 ? { drive: E.consumed_wh.drive / E.consumed_wh.total, dwell: E.consumed_wh.dwell / E.consumed_wh.total, wait: E.consumed_wh.wait / E.consumed_wh.total } : null, balance_check_wh: E.balance_check_wh, provenance: 'simulated' },
      time: { run_elapsed_s: T.run_elapsed_s, mission_elapsed_s: T.elapsed_s, by_activity_s: T.time_by_activity_s, limit_s: report.limits.max_mission_s, remaining_s: report.limits.max_mission_s != null ? Math.max(0, report.limits.max_mission_s - T.elapsed_s) : null, provenance: 'simulated' },
      distance: { travelled_this_run_m: T.distance_travelled_this_run_m, planned_total_m: T.planned_distance_m, progress_fraction: T.progress_fraction, provenance: 'simulated' },
      equipment: equipment, consumables: inventory
    };

    // ---- estimates (pre-run) -----------------------------------------------------------
    var est = input.estimate || report.plan_estimate || null;
    if (!est && Sim && plan) { var er = Sim.estimatePlan(plan, rover, {}); est = er.estimate; if (er.errors.length) notes.push('Pre-run estimate unavailable: ' + er.errors.join('; ')); }
    var estPlanConsumables = consumablesFromObjectives(planObjs, function () { return true; });
    var estCost = null, qEst = null;
    if (est) { qEst = qFromEstimate(est, usable); estCost = components(qEst, A, rover, plan, { estimated: estPlanConsumables }); }
    else notes.push('No pre-run estimate: pass `plan` with FieldZeroSim available, or an `estimate` object.');
    var simCost = components(qSim, A, rover, plan, { simulated: usedSim });
    var meas = null, measCost = null;
    if (tele) { var qM = qFromTelemetry(tele, usable); measCost = components(qM, A, rover, plan, { measured: qM.consumables_used }); meas = { elapsed_s: qM.elapsed_s, distance_m: qM.distance_m, energy_wh: qM.energy_wh, net_discharge_wh: qM.net_discharge_wh, provenance: 'measured (caller-supplied telemetry)' }; }
    else notes.push('No telemetry supplied: there are no measured values. "Actual" numbers below are simulated accumulations, not measurements.');

    // ---- variance estimated -> simulated -> measured -------------------------------------
    function vrow(name, e, s, m) { var d = (e != null && s != null) ? s - e : null; return { quantity: name, estimated: e == null ? null : rd(e, 3), simulated: rd(s, 3), measured: m == null ? null : rd(m, 3), simulated_minus_estimated: d == null ? null : rd(d, 3), pct_vs_estimate: (d != null && e) ? rd(100 * d / e, 2) : null,
      measured_minus_simulated: (m != null && s != null) ? rd(m - s, 3) : null }; }
    var variance = [vrow('elapsed_s', est && est.time_s, qSim.elapsed_s, meas && meas.elapsed_s), vrow('distance_m', est && est.distance_m, qSim.distance_m, meas && meas.distance_m), vrow('energy_consumed_wh', est && est.energy_wh, qSim.energy_wh, meas && meas.energy_wh),
      vrow('cost_total', estCost && estCost.total, simCost.total, measCost && measCost.complete ? measCost.total : null)];
    var varNote = 'Estimate and simulation share one assumed model, so differences come from early stops, recovery actions, solar credit and rounding, not from model error.';

    // ---- remaining resources and shortages ---------------------------------------------
    var remaining = { energy_above_reserve_wh: rd(E.end_wh - E.reserve_wh, 3), time_s: ledger.time.remaining_s, equipment: equipment.map(function (e) { return { id: e.id, remaining_hours: e.remaining_hours }; }),
      consumables: inventory.map(function (c) { return { id: c.id, remaining: c.remaining, unit: c.unit }; }), provenance: 'simulated' };
    var shortages = [], incomplete = report.objectives.some(function (o) { return o.status === 'incomplete'; }) || report.status === 'halted';
    var remEst = null;
    if (incomplete) {
      if (Sim && plan && report.resume) { var rr = Sim.estimatePlan(plan, rover, { initial: report.resume }); remEst = rr.estimate; if (rr.errors.length) notes.push('Remaining-route estimate unavailable: ' + rr.errors.join('; ')); }
      else notes.push('Remaining requirements could not be estimated (needs plan, rover and FieldZeroSim).');
    }
    if (remEst) {
      var availE = E.end_wh - E.reserve_wh, upper = Math.max(0, remEst.energy_wh - availE), lower = Math.max(0, remEst.energy_wh - remEst.solar_credit_upper_bound_wh - availE);
      if (upper > 1e-6) shortages.push({ resource: 'energy', unit: 'Wh', required: rd(remEst.energy_wh, 2), available: rd(availE, 2), shortfall_upper: rd(upper, 2), shortfall_lower: rd(lower, 2),
        note: lower < upper ? 'Range because a constant charging source exists; the lower value assumes all of it is usable.' : 'No charging credit available; shortfall is exact under the model.', provenance: 'estimated' });
      var lim = report.limits.max_mission_s;
      if (isNum(lim) && T.elapsed_s + remEst.time_s > lim + 1e-6) shortages.push({ resource: 'time', unit: 's', required: rd(remEst.time_s, 1), available: rd(Math.max(0, lim - T.elapsed_s), 1), shortfall_upper: rd(T.elapsed_s + remEst.time_s - lim, 1), shortfall_lower: rd(T.elapsed_s + remEst.time_s - lim, 1), note: '', provenance: 'estimated' });
      equipment.forEach(function (e) { if (e.available_hours == null) return;
        var need = ((e.duty === 'drive' ? remEst.drive.time_s : e.duty === 'dwell' ? remEst.dwell.time_s : e.duty === 'wait' ? 0 : remEst.time_s) / 3600);
        if (need > e.remaining_hours + 1e-9) shortages.push({ resource: 'equipment:' + e.id, unit: 'h', required: rd(need, 3), available: e.remaining_hours, shortfall_upper: rd(need - e.remaining_hours, 3), shortfall_lower: rd(need - e.remaining_hours, 3), note: 'duty = ' + e.duty, provenance: 'estimated' }); });
    }
    var pendNeed = consumablesFromObjectives(report.objectives, function (o) { return o.status === 'incomplete'; });
    inventory.forEach(function (c) { if (c.available == null) return; var need = pendNeed[c.id] || 0;
      if (need > (c.remaining || 0) + 1e-9) shortages.push({ resource: 'consumable:' + c.id, unit: c.unit, required: need, available: c.remaining, shortfall_upper: rd(need - c.remaining, 4), shortfall_lower: rd(need - c.remaining, 4), note: 'needed by incomplete objectives', provenance: 'estimated' }); });
    if (!equipment.length && !inventory.length) notes.push('No equipment or consumables declared (rover.equipment, plan.resources): only energy, time and distance are tracked.');

    return {
      contract: CONTRACT, version: VERSION, status: 'ok', plan_id: report.plan_id, ledger: ledger,
      estimates: est ? { time_s: est.time_s, energy_wh: est.energy_wh, distance_m: est.distance_m, provenance: 'estimated (analytic, assumed model)' } : null,
      actuals: { simulated: { elapsed_s: qSim.elapsed_s, distance_m: qSim.distance_m, energy_consumed_wh: qSim.energy_wh, net_discharge_wh: qSim.net_discharge_wh, provenance: 'simulated (assumed model); not measured' }, measured: meas },
      variance: { rows: variance, note: varNote },
      remaining: remaining, remaining_route_estimate: remEst ? { time_s: remEst.time_s, energy_wh: remEst.energy_wh, distance_m: remEst.distance_m, provenance: 'estimated' } : null, shortages: shortages,
      cost: { currency: A.currency, estimated: estCost, simulated: simCost, measured: measCost, formula_summary: 'total = operations + energy + mobility + battery_wear + sum(equipment) + sum(consumables); each line prints its own formula', cost_per_km_simulated: qSim.distance_m > 0 ? rd(simCost.total / (qSim.distance_m / 1000), 3) : null },
      assumptions: A, notes: notes, limitations: LIMITATIONS.slice()
    };
  }

  return { version: VERSION, CONTRACT: CONTRACT, DEFAULT_ASSUMPTIONS: DEFAULT_ASSUMPTIONS, LIMITATIONS: LIMITATIONS, resolveAssumptions: resolveAssumptions, compute: compute };
});
