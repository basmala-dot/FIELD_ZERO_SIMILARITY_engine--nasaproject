/*! FIELD//ZERO mission extras: shared core (v1.0.0)
 *
 *  Shared by the four independent mission views:
 *      mission-timeline.js        window.FZTimeline      mission phases and progress
 *      mission-event-log.js       window.FZEventLog      filterable event log
 *      mission-comparison.js      window.FZComparison    FAST / SAFE / SCIENTIFIC comparison
 *      mission-dossier-view.js    window.FZDossierView   mission dossier, print and export
 *
 *  WHAT THIS FILE DOES
 *    1. Reads mission data the project ALREADY produces and normalises it into one read-only "bundle".
 *       It computes nothing scientific: no routes, no risk, no cost, no success probability.
 *    2. Offers tiny shared UI helpers (element builder, formatters, basis chips) used by the four views.
 *    3. Keeps views in sync (polls window.FZ.mission cheaply, or reacts to FZExtras.setMission()).
 *
 *  WHAT THIS FILE NEVER DOES
 *    - It never modifies index.html, style.css, app.js, mission-ui.js, mission-model.js, mission-engine.js or any
 *      simulation module, and it never writes to window.FZ.
 *    - It never invents a value. A missing value is null and every view shows it as "n/a" (an em dash).
 *    - It never mixes development-fixture data with real results (the fixture flag is surfaced as a banner).
 *
 *  DATA SOURCES (any subset works; views degrade to an honest empty state)
 *    A  window.FZ.mission            state kept by mission-ui.js (contract 1.0): plan, runs, scenarios, setup, playback.
 *    B  FZExtras.setMission({...})   explicit input, or document event  fz:mission-data  { detail: {...} }:
 *         plan      output of FieldZeroMission.run()/optimize()   (Person 1 planning engine, FAST/SAFE/SCIENTIFIC)
 *         results   FieldZeroResults.run()/build()   "FZ-MISSION-RESULTS-0.1"   (Person 3 final report)
 *         report    FieldZeroSim report "FZ-SIM-REPORT-0.1"       (events, segments, objectives)
 *         failure   FieldZeroFailure.analyze()  "FZ-FAILURE-ANALYSIS-0.1"
 *         cost      FieldZeroCost.compute()     "FZ-COST-0.1"
 *         scenarios FieldZeroScenario.run()     "FZ-SCENARIOS-0.1"
 *         uiPlan / run / runs / setup / selectedStrategy / playback   contract-1.0 objects (see mission-ui.js)
 *    C  window.FZShell.getSetup()    builder values (used only for the configuration section).
 *
 *  VALUE BASIS (shown as a small chip next to numbers, see BASIS)
 *    dataset    read from a processed project dataset          user       typed in by the mission owner
 *    model      output of the similarity model                  estimate   planning-time estimate, assumed vehicle model
 *    simulated  produced by a simulation run (NOT a measurement) heuristic  transparent index, not a probability
 *    assumption / placeholder   stand-in value chosen by the team, not measured
 *    n/a        unavailable: the project has no value, so none is shown.
 *    Nothing in this project is flight-measured, so "measured" only appears if a caller supplies telemetry.
 *
 *  Works in browsers (window.FZExtras) and Node 18+ (require) for the pure normalisers; DOM helpers need a document.
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && !root.FZExtras) root.FZExtras = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function (root) {
  'use strict';

  var VERSION = '1.0.0';
  var NA = '—';
  var STRATS = ['FAST', 'SAFE', 'SCIENTIFIC'];
  var STRAT_LABEL = { FAST: 'Fast', SAFE: 'Safe', SCIENTIFIC: 'Scientific' };
  var SEVERITIES = ['info', 'warning', 'critical'];
  var SEV_LABEL = { info: 'Info', warning: 'Warning', critical: 'Critical' };
  var TYPES = ['navigation', 'objective', 'resource', 'terrain', 'failure', 'recovery', 'system'];
  var TYPE_LABEL = { navigation: 'Navigation', objective: 'Objective', resource: 'Resource', terrain: 'Terrain', failure: 'Failure', recovery: 'Recovery', system: 'System' };
  var BASIS = {
    dataset: 'Project data', user: 'User input', model: 'Model output', estimate: 'Estimate', simulated: 'Simulated',
    heuristic: 'Heuristic index', assumption: 'Assumption', placeholder: 'Placeholder', measured: 'Measured', constant: 'External constant', na: 'Not available'
  };
  var BASIS_HELP = {
    dataset: 'Read from a processed project dataset.',
    user: 'Typed in by the mission owner.',
    model: 'Output of the terrain-similarity model. Not a confirmed analog.',
    estimate: 'Planning-time estimate from an assumed vehicle model.',
    simulated: 'Produced by a simulation run with an assumed model. Not a measurement.',
    heuristic: 'Transparent index built from assumptions. Not a probability.',
    assumption: 'A value chosen by the team, not measured.',
    placeholder: 'A generic stand-in for a value the user has not supplied.',
    measured: 'Real telemetry supplied by the caller.',
    constant: 'A published physical constant that is not part of the project datasets.',
    na: 'The project has no value for this, so none is shown.'
  };
  var BASIS_ALIAS = { project_data: 'dataset', model_output: 'model', user_input: 'user', external_constant: 'constant', estimated: 'estimate', 'real/plan input': 'dataset', 'plan input': 'dataset' };
  function basisOf(b) { if (!b) return null; b = String(b).toLowerCase(); if (BASIS_ALIAS[b]) return BASIS_ALIAS[b]; if (BASIS[b]) return b; if (/^simulated/.test(b)) return 'simulated'; return null; }

  // ------------------------------------------------------------------ small helpers
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function arr(v) { return Array.isArray(v) ? v : []; }
  function cap(s) { s = String(s == null ? '' : s); return s.charAt(0).toUpperCase() + s.slice(1); }
  function words(s) { return cap(String(s == null ? '' : s).replace(/_/g, ' ').toLowerCase()); }
  function first() { for (var i = 0; i < arguments.length; i++) if (arguments[i] !== undefined && arguments[i] !== null) return arguments[i]; return null; }
  function num(v, d) { return isNum(v) ? v.toLocaleString('en-US', { maximumFractionDigits: d == null ? 1 : d }) : NA; }
  function fmtDur(s) {
    if (!isNum(s)) return NA; s = Math.round(Math.max(0, s));
    if (s < 60) return s + ' s';
    var m = Math.floor(s / 60), sec = s % 60;
    if (m < 60) return m + ' min' + (sec && m < 10 ? ' ' + sec + ' s' : '');
    var hr = Math.floor(m / 60); m = m % 60;
    if (hr < 48) return hr + ' h' + (m ? ' ' + m + ' min' : '');
    var d = Math.floor(hr / 24); hr = hr % 24; return d + ' d' + (hr ? ' ' + hr + ' h' : '');
  }
  function fmtClock(s) {
    if (!isNum(s)) return NA; s = Math.max(0, Math.round(s)); var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return 'T+' + p(Math.floor(s / 3600)) + ':' + p(Math.floor(s / 60) % 60) + ':' + p(s % 60);
  }
  function fmtDist(m) { return !isNum(m) ? NA : (Math.abs(m) < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(2) + ' km'); }
  function fmtWh(v) { return isNum(v) ? (Math.abs(v) >= 1000 ? num(v / 1000, 2) + ' kWh' : num(v, 1) + ' Wh') : NA; }
  function fmtMoney(v, cur) { return isNum(v) ? num(v, 2) + (cur ? ' ' + shortCur(cur) : '') : NA; }
  function shortCur(c) { c = String(c || ''); var m = /^([A-Za-z]{1,6})\b/.exec(c); return m ? m[1] : c; }
  function fmtPct(f, d) { return isNum(f) ? (f * 100).toFixed(d == null ? 0 : d) + ' %' : NA; }
  function fmtPctRaw(p, d) { return isNum(p) ? p.toFixed(d == null ? 1 : d) + ' %' : NA; }
  function fmtIdx(v) { return isNum(v) ? num(v, 1) : NA; }
  function slug(s) { return String(s == null ? '' : s).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'x'; }
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function round(v, d) { if (!isNum(v)) return null; var f = Math.pow(10, d == null ? 2 : d); return Math.round(v * f) / f; }
  function lonlat(lon, lat) { return isNum(lon) && isNum(lat) ? Math.abs(lat).toFixed(4) + '°' + (lat < 0 ? 'S' : 'N') + ', ' + Math.abs(lon).toFixed(4) + '°' + (lon < 0 ? 'W' : 'E') : null; }

  // ------------------------------------------------------------------ DOM helpers (browser only)
  function doc() { return root && root.document ? root.document : null; }
  function h(tag, attrs, kids) {
    var d = doc(); if (!d) throw new Error('FZExtras DOM helpers need a document.');
    var e = d.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k]; if (v == null || v === false) return;
      if (k === 'text') e.textContent = v; else if (k === 'class') e.className = v; else if (k === 'style') e.style.cssText = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : String(v));
    });
    arr(kids).forEach(function (c) { if (c == null || c === false) return; e.appendChild(typeof c === 'string' ? d.createTextNode(c) : c); });
    return e;
  }
  function clear(el) { if (el) while (el.firstChild) el.removeChild(el.firstChild); return el; }
  function basisChip(kind, extraTitle) {
    var b = basisOf(kind) || 'na';
    return h('span', { class: 'fzx-basis', 'data-b': b, title: (BASIS_HELP[b] || '') + (extraTitle ? ' ' + extraTitle : ''), text: BASIS[b] });
  }
  function legend(kinds) {
    return h('p', { class: 'fzx-legend' }, [h('span', { class: 'fzx-legend-t', text: 'Value basis' })].concat(kinds.map(function (k) { return h('span', { class: 'fzx-legend-i' }, [basisChip(k)]); })));
  }
  function empty(text, hint) { return h('div', { class: 'fzx-empty', role: 'note' }, [h('p', { text: text }), hint ? h('p', { class: 'src', text: hint }) : null]); }
  function fixtureBanner() { return h('div', { class: 'fz-alert fzx-fixture', 'data-kind': 'warn', role: 'note' }, [h('span', { text: 'Development fixture data. These numbers are not real mission engine results and must not be used as findings.' })]); }
  function download(name, text, type) {
    var d = doc(); if (!d || !root.URL || !root.Blob) return false;
    var a = h('a', { href: root.URL.createObjectURL(new root.Blob([text], { type: type || 'text/plain' })), download: name });
    d.body.appendChild(a); a.click(); a.remove(); root.setTimeout(function () { root.URL.revokeObjectURL(a.href); }, 800); return true;
  }
  function csvCell(v) { v = v == null ? '' : String(v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }

  // ==================================================================================================
  //  NORMALISERS (pure functions, no DOM)
  // ==================================================================================================
  function isEnginePlan(p) { return isObj(p) && isObj(p.strategies) && (p.strategies.FAST || p.strategies.SAFE || p.strategies.SCIENTIFIC) && true; }
  function isUiPlan(p) { return isObj(p) && isObj(p.strategies) && (p.strategies.fast || p.strategies.safe || p.strategies.scientific) && true; }
  function isUiRun(r) { return isObj(r) && typeof r.run_id === 'string' && isObj(r.timeline) && isObj(r.route); }
  function isResults(r) { return isObj(r) && r.contract === 'FZ-MISSION-RESULTS-0.1'; }
  function isReport(r) { return isObj(r) && typeof r.contract === 'string' && r.contract.indexOf('FZ-SIM-REPORT') === 0; }
  function stratKey(s) { s = String(s == null ? '' : s).toUpperCase(); return STRATS.indexOf(s) >= 0 ? s : null; }

  // ---------------------------------------------------------------- metric catalogue for the strategy comparison
  // better: 'lower' | 'higher' | null (more is not automatically better).  scale: fixed maximum for bar length, or null = largest value shown.
  var METRICS = [
    { id: 'duration', group: 'Time and resources', label: 'Mission duration', better: 'lower', kind: 'dur', scale: null, help: 'Total mission time. For planning-engine estimates this is driving time plus the assumed time at each site.' },
    { id: 'distance', group: 'Time and resources', label: 'Route distance', better: 'lower', kind: 'dist', scale: null, help: 'Length of the planned route.' },
    { id: 'energy', group: 'Time and resources', label: 'Energy used', better: 'lower', kind: 'wh', scale: null, help: 'Energy needed by the assumed vehicle model.' },
    { id: 'margin', group: 'Time and resources', label: 'Energy margin', better: 'higher', kind: 'pct', scale: 100, help: 'Energy left after the reserve, as a share of capacity. Only available when a battery budget was given.' },
    { id: 'cost', group: 'Time and resources', label: 'Expected cost', better: 'lower', kind: 'money', scale: null, help: 'Expected cost in the units the engine reports.' },
    { id: 'risk', group: 'Risk', label: 'Risk index', better: 'lower', kind: 'idx', scale: 100, help: 'Heuristic terrain-hazard index, 0 to 100. Not a probability of failure.' },
    { id: 'success', group: 'Risk', label: 'Success chance', better: 'higher', kind: 'frac', scale: 1, help: 'Success probability, only if the engine reports one.' },
    { id: 'science', group: 'Scientific value', label: 'Science score', better: 'higher', kind: 'frac', scale: 1, help: 'Heuristic: mean similarity of visited sites, scaled by how many science stops were reached.' },
    { id: 'similarity', group: 'Scientific value', label: 'Mean site similarity', better: 'higher', kind: 'idx', scale: 100, help: 'Terrain-metric similarity of the visited sites to the target reference (0 to 100). Not a confirmed analog.' },
    { id: 'sites', group: 'Scientific value', label: 'Sites visited', better: null, kind: 'int', scale: null, help: 'How many sites the route reaches.' }
  ];
  function metricMap() { var m = {}; METRICS.forEach(function (x) { m[x.id] = x; }); return m; }

  function mval(v, basis, src, note) { return isNum(v) ? { v: v, basis: basisOf(basis) || 'estimate', src: src || null, note: note || null } : null; }

  /** Strategy comparison model from the engine plan (FAST/SAFE/SCIENTIFIC) and/or the contract-1.0 plan (fast/safe/scientific). */
  function normalizeStrategies(src) {
    var ep = isEnginePlan(src.plan) ? src.plan : null, up = isUiPlan(src.uiPlan) ? src.uiPlan : null;
    var out = { available: false, sources: [], items: {}, recommended: null, recommendation: null, best_by: null, tradeoffs: [], same_goal: null, scoring: null, caveats: [], currency: null };
    STRATS.forEach(function (k) { out.items[k] = { id: k, label: STRAT_LABEL[k], intent: null, present: false, feasible: null, reason: null, budget_check: null, confidence: null, risk_class: null, metrics: {} }; });
    if (ep) {
      out.sources.push('engine-plan'); out.available = true;
      var tbl = {}; arr(ep.comparison && ep.comparison.table).forEach(function (r) { tbl[r.strategy] = r; });
      STRATS.forEach(function (k) {
        var s = ep.strategies[k], it = out.items[k]; if (!s) return;
        it.present = true; it.intent = s.intent || null;
        var ok = s.route && s.route.status === 'ok';
        it.feasible = ok ? (s.resources && s.resources.feasible === false ? false : true) : false;
        it.budget_check = s.resources && s.resources.feasible !== undefined ? s.resources.feasible : null;
        if (!ok) it.reason = (s.route && arr(s.route.explanation)[0]) || ('Route status: ' + (s.route && s.route.status || 'unknown'));
        else if (s.resources && s.resources.feasible === false) it.reason = (s.resources.note || 'A supplied budget is exceeded.');
        var t = s.totals || {}, row = tbl[k] || {}, sc = row.scores || {};
        it.confidence = (s.confidence && s.confidence.level) || row.confidence || null;
        it.risk_class = (s.risk && s.risk.class) || row.risk_class || null;
        if (ok) {
          it.metrics.duration = mval(isNum(t.total_time_h) ? t.total_time_h * 3600 : null, 'estimate', 'engine-plan', 'driving + assumed dwell');
          it.metrics.distance = mval(t.distance_m, 'estimate', 'engine-plan');
          it.metrics.energy = mval(t.energy_wh, 'estimate', 'engine-plan');
          var em = s.resources && s.resources.energy;
          it.metrics.margin = em && em.status !== 'not_evaluated' ? mval(isNum(em.margin_fraction) ? em.margin_fraction * 100 : null, 'estimate', 'engine-plan') : null;
          it.metrics.risk = mval(s.risk ? s.risk.mission_risk_index : row.mission_risk_index, 'heuristic', 'engine-plan');
          it.metrics.science = mval(sc.science, 'heuristic', 'engine-plan');
          it.metrics.similarity = mval(s.similarity ? s.similarity.mean_score : row.mean_site_similarity, 'model', 'engine-plan');
          it.metrics.sites = mval(isNum(t.n_sites_visited) ? t.n_sites_visited : row.n_sites_visited, 'estimate', 'engine-plan');
          it.scores = { speed: isNum(sc.speed) ? sc.speed : null, safety: isNum(sc.safety) ? sc.safety : null, science: isNum(sc.science) ? sc.science : null, total: isNum(sc.total) ? sc.total : null };
        }
      });
      var c = ep.comparison || {};
      out.recommended = stratKey(c.recommendation && c.recommendation.strategy) || stratKey(ep.recommended_strategy);
      out.recommendation = c.recommendation || null; out.best_by = c.best_by || null; out.tradeoffs = arr(c.tradeoffs).slice();
      out.scoring = c.scoring || null;
      if (c.same_goal_routes && isObj(c.same_goal_routes.per_strategy)) out.same_goal = c.same_goal_routes;
      out.caveats = arr(c.recommendation && c.recommendation.caveats).slice();
    }
    if (up) {
      out.sources.push('ui-plan'); out.available = true;
      out.currency = up.currency || null;
      STRATS.forEach(function (k) {
        var s = up.strategies[k.toLowerCase()], it = out.items[k]; if (!s) return;
        var fresh = !it.present; it.present = true;
        if (fresh) { it.feasible = !!s.feasible; it.reason = s.feasible ? null : (s.infeasible_reason || 'The engine gave no reason.'); }
        var m = s.feasible && isObj(s.summary) ? s.summary : null; if (!m) return;
        var put = function (id, v) { if (!it.metrics[id]) it.metrics[id] = v; };
        put('duration', mval(m.duration_s, 'estimate', 'ui-plan')); put('distance', mval(m.distance_m, 'estimate', 'ui-plan'));
        put('energy', mval(m.energy_used_wh, 'estimate', 'ui-plan')); put('margin', mval(m.energy_margin_pct, 'estimate', 'ui-plan'));
        put('cost', mval(m.cost_expected, 'estimate', 'ui-plan'));
        if (m.risk && !it.metrics.risk && isNum(m.risk.score)) it.metrics.risk = mval(m.risk.score, 'heuristic', 'ui-plan', 'scale as reported by the engine');
        if (m.risk && m.risk.level && !it.risk_class) it.risk_class = m.risk.level;
        put('success', mval(m.success_probability, 'estimate', 'ui-plan', m.success_probability_method || null));
      });
    }
    // Cost and success are never produced by the planning engine; they stay null when no source supplies them.
    return out;
  }

  // ---------------------------------------------------------------- events
  var RX = {
    recovery: /RECOVER|RETRY|DESCOPE|ALTERNATE|DETOUR_TAKEN|WAIT_|RESUME|REPLAN/i,
    navigation: /WAYPOINT|ROUTE|LEG\b|LEG_|NAVIG|ARRIV|DEPART|REROUT|HEADING|START|GOAL|STAGING|TRAVERSE|DRIVE/i,
    objective: /OBJECTIVE|SAMPLE|SCIENCE|DWELL|MEASUR|IMAG|DRILL/i,
    resource: /BATTERY|ENERGY|POWER|TIME_LIMIT|RESOURCE|EQUIPMENT|CONSUMABLE|CHARGE|RESERVE|BUDGET|THERMAL/i,
    terrain: /SLOPE|ROUGH|TERRAIN|HAZARD|BLOCKED|TRACTION|SLIP|BOULDER|CRATER|KEEP.?OUT/i,
    failure: /FAIL|FAULT|IMMOBIL|HALT|LOSS|LOST|ABORT|DEPLETED|SIM_GUARD/i
  };
  function classifyType(raw, severity, code, text) {
    var t = String(raw || '').toLowerCase();
    if (TYPES.indexOf(t) >= 0) return t;
    var probe = [raw, code].filter(Boolean).join(' ');
    var order = ['recovery', 'objective', 'navigation', 'resource', 'terrain', 'failure'];
    var i; for (i = 0; i < order.length; i++) if (RX[order[i]].test(probe)) { t = order[i]; break; }
    if (TYPES.indexOf(t) < 0) {
      var probe2 = String(text || '');
      for (i = 0; i < order.length; i++) if (RX[order[i]].test(probe2.toUpperCase().replace(/ /g, '_'))) { t = order[i]; break; }
    }
    if (TYPES.indexOf(t) < 0) t = severity === 'critical' ? 'failure' : 'system';
    // a critical event caused by a resource or terrain limit is a failure of that kind
    return t;
  }
  function sevOf(s) { s = String(s || 'info').toLowerCase(); if (s === 'failure' || s === 'error' || s === 'fatal' || s === 'severe') return 'critical'; if (s === 'warn') return 'warning'; return SEVERITIES.indexOf(s) >= 0 ? s : 'info'; }

  function ev(o) {
    return { id: o.id, t_s: isNum(o.t_s) ? o.t_s : null, type: o.type, subject: o.subject || null, severity: o.severity, title: o.title, detail: o.detail || null,
      code: o.code || null, source: o.source, origin: o.origin || 'event', basis: o.basis || 'simulated', ref: o.ref || null };
  }
  function recoveryText(r, labels) {
    if (!isObj(r)) return null;
    var o = r.outcome ? words(r.outcome) : null, p = r.policy ? ((labels && labels[r.policy]) || r.policy) : null;
    return [o, p].filter(Boolean).join(' · ') || null;
  }
  function eventsFromUiRun(run, tag, labels) {
    var out = [], seenFail = {};
    arr(run.events).forEach(function (e, i) {
      var sev = sevOf(e.severity), code = e.code || e.kind || e.type || null;
      if (e.failure_id) seenFail[e.failure_id] = true;
      out.push(ev({ id: tag + ':e' + i, t_s: e.t_s, type: classifyType(e.type || e.kind || e.category, sev, code, e.title), severity: sev, title: String(e.title == null ? '' : e.title), detail: e.detail, code: code, source: 'ui-run', ref: e.failure_id || null }));
    });
    arr(run.failures).forEach(function (f, i) {
      var sev = sevOf(f.severity), dup = seenFail[f.id];
      if (!dup) out.push(ev({ id: tag + ':f' + i, t_s: f.t_s, type: 'failure', subject: classifyType(f.kind, 'info', f.kind, f.component) === 'terrain' ? 'terrain' : null, severity: sev === 'info' ? 'warning' : sev,
        title: 'Failure: ' + (f.component || f.kind || 'component'), detail: [f.root_cause, f.impact ? 'Impact: ' + f.impact : null, f.caused_mission_loss ? 'This caused the mission loss.' : null].filter(Boolean).join(' '), code: f.kind || null, source: 'ui-run', origin: 'failure-record', ref: f.id }));
      var rt = recoveryText(f.recovery, labels);
      if (rt) out.push(ev({ id: tag + ':r' + i, t_s: f.t_s, type: 'recovery', severity: f.recovered === false ? 'warning' : 'info', title: 'Recovery: ' + rt,
        detail: [isNum(f.recovery.time_cost_s) ? 'time ' + fmtDur(f.recovery.time_cost_s) : null, isNum(f.recovery.energy_cost_wh) ? 'energy ' + fmtWh(f.recovery.energy_cost_wh) : null,
          f.recovered === true ? 'recovered' : f.recovered === false ? 'not recovered' : null].filter(Boolean).join(' · '), source: 'ui-run', origin: 'recovery-record', ref: f.id }));
    });
    return out;
  }
  function eventsFromSim(report, failure, results, tag) {
    var out = [], byKey = {};
    arr(report && report.events).forEach(function (e, i) {
      var sev = sevOf(e.severity), x = ev({ id: tag + ':e' + i, t_s: e.t_s, type: classifyType(null, sev, e.code, e.message), severity: sev, title: words(e.code), detail: e.message, code: e.code, source: 'simulation' });
      if (sev === 'critical') { var sub = classifyType(null, 'info', e.code, ''); if (sub === 'resource' || sub === 'terrain') x.subject = sub; x.type = 'failure'; }
      out.push(x); byKey[e.code + '@' + Math.round(e.t_s || 0)] = x;
    });
    var fl = failure && arr(failure.failures).length ? failure.failures : (results && results.failures && results.failures.items) || [];
    arr(fl).forEach(function (f, i) {
      var key = f.code + '@' + Math.round(f.t_s || 0), x = byKey[key];
      var cause = f.cause_summary || (f.causes && f.causes.summary) || null;
      if (x) { x.ref = f.id || null; if (cause) x.detail = (x.detail ? x.detail + ' ' : '') + 'Cause: ' + cause; }
      else out.push(ev({ id: tag + ':f' + i, t_s: f.t_s, type: 'failure', severity: 'critical', title: words(f.code), detail: [f.message, cause ? 'Cause: ' + cause : null].filter(Boolean).join(' '), code: f.code, source: 'failure-analysis', origin: 'failure-record', ref: f.id || null }));
      var rec = f.recovery || null;
      if (rec && rec.evaluated) out.push(ev({ id: tag + ':ra' + i, t_s: f.t_s, type: 'recovery', severity: rec.feasibility === 'full' ? 'info' : rec.feasibility === 'partial' ? 'warning' : 'critical',
        title: 'Recovery evaluated: ' + (rec.best_action_id ? words(rec.best_action_id) : 'no action improves the outcome'), detail: rec.explanation || ('Feasibility: ' + rec.feasibility), code: 'RECOVERY_EVALUATED', source: 'failure-analysis', origin: 'recovery-record', ref: f.id || null }));
    });
    var ex = results && results.recovery && results.recovery.executed;
    if (ex && ex.executed) out.push(ev({ id: tag + ':rx', t_s: results.progress && results.progress.stopped_by ? results.progress.stopped_by.t_s : null, type: 'recovery', severity: ex.feasible ? 'info' : 'warning',
      title: 'Recovery simulated: ' + words(ex.action_id), detail: [ex.feasibility_reason, ex.outcome ? 'Outcome ' + words(ex.outcome.mission_class || ex.outcome.status) + '.' : null].filter(Boolean).join(' '), code: 'RECOVERY_SIMULATED', source: 'results', origin: 'recovery-record', ref: ex.failure_id || null }));
    return out;
  }
  function sortEvents(list) {
    return list.map(function (e, i) { return [e, i]; }).sort(function (a, b) {
      var x = a[0].t_s, y = b[0].t_s; if (x == null && y == null) return a[1] - b[1]; if (x == null) return 1; if (y == null) return -1; return (x - y) || (a[1] - b[1]);
    }).map(function (p) { return p[0]; });
  }

  // ---------------------------------------------------------------- failures, cost, resources (normalised across sources)
  function failuresFrom(run, failure, results, labels) {
    var out = [];
    if (run) arr(run.failures).forEach(function (f) {
      out.push({ id: f.id, t_s: f.t_s, severity: sevOf(f.severity), component: f.component || null, code: f.kind || null, message: f.root_cause || null, cause: f.root_cause || null, impact: f.impact || null,
        recovered: f.recovered === true ? true : f.recovered === false ? false : null, recovery: recoveryText(f.recovery, labels), recovery_costs: isObj(f.recovery) ? { time_s: f.recovery.time_cost_s, energy_wh: f.recovery.energy_cost_wh, cost: f.recovery.cost_delta } : null,
        caused_loss: !!f.caused_mission_loss, basis: 'simulated' });
    });
    else {
      var src = (failure && arr(failure.failures).length) ? failure.failures : arr(results && results.failures && results.failures.items);
      arr(src).forEach(function (f) {
        var rec = f.recovery || {}, c = f.cause_summary || (f.causes && f.causes.summary) || null, imp = (f.consequences && f.consequences.text) || (f.mission_impact && f.mission_impact.text) || null;
        var FEAS = { full: 'Full recovery', partial: 'Partial recovery', none: 'No feasible recovery', not_evaluated: 'Recovery not evaluated' };
        var rtxt = rec.evaluated === false ? 'Recovery not evaluated' : (rec.feasibility ? (FEAS[rec.feasibility] || words(rec.feasibility)) + (rec.best_action_id ? ' · ' + words(rec.best_action_id) : '') : null);
        out.push({ id: f.id, t_s: f.t_s, severity: sevOf(f.severity), component: f.code ? words(f.code) : null, code: f.code || null, message: f.message || null, cause: c, impact: imp,
          recovered: rec.feasibility === 'full' ? true : rec.feasibility === 'none' ? false : null, recovery: rtxt, recovery_costs: null, caused_loss: !!(f.consequences && f.consequences.stops_mission), basis: 'simulated' });
      });
    }
    return out;
  }
  function costFrom(run, costMod, results, currency) {
    if (run && isObj(run.cost)) {
      var c = run.cost, e = c.energy || {}, q = c.equipment || {}, d = c.duration || {};
      return { kind: 'ui-run', currency: c.currency || currency || null, basis: 'simulated', expected: isNum(c.expected) ? c.expected : null, low: isNum(c.low) ? c.low : null, high: isNum(c.high) ? c.high : null,
        within_budget: c.within_budget === true ? true : c.within_budget === false ? false : null,
        breakdown: arr(c.breakdown).map(function (r) { return { category: r.category, low: r.low, expected: r.expected, high: r.high, basis: basisOf(r.basis) || null, quantity: null, unit: null, formula: null }; }),
        energy: { capacity_wh: first(e.capacity_wh), used_wh: first(e.used_wh), margin_wh: first(e.margin_wh), margin_pct: first(e.margin_pct), reserve_ok: e.reserve_ok === true ? true : e.reserve_ok === false ? false : null },
        duration: { planned_s: first(d.planned_s), limit_s: first(d.limit_s), within_limit: d.within_limit === true ? true : d.within_limit === false ? false : null },
        equipment: { used: arr(q.used), listed: isNum(q.listed) ? q.listed : null }, notes: arr(c.assumptions) };
    }
    var cm = costMod || (results && results.cost) || null;
    if (cm && cm.contract === 'FZ-COST-0.1' && cm.cost) {      // raw FieldZeroCost.compute() output -> same digest as results.cost
      var rc = cm.cost, ra = cm.assumptions || {};
      cm = { currency: rc.currency, rate_provenance: ra.provenance || null, estimated_total: rc.estimated && rc.estimated.total, simulated_total: rc.simulated && rc.simulated.total, measured_total: rc.measured && rc.measured.total,
        components_simulated: rc.simulated && rc.simulated.complete !== false ? arr(rc.simulated.components) : arr(rc.simulated && rc.simulated.components), components_estimated: arr(rc.estimated && rc.estimated.components), note: arr(cm.notes)[0] || null };
    }
    if (cm && (cm.components_simulated || cm.estimated_total != null)) {
      var comps = arr(cm.components_simulated).length ? cm.components_simulated : arr(cm.components_estimated);
      var kind = arr(cm.components_simulated).length ? 'simulated' : 'estimate';
      return { kind: 'p3-cost', currency: cm.currency || null, rate_basis: cm.rate_provenance || null, basis: kind,
        expected: isNum(cm.simulated_total) ? cm.simulated_total : (isNum(cm.estimated_total) ? cm.estimated_total : null), estimated_total: isNum(cm.estimated_total) ? cm.estimated_total : null,
        simulated_total: isNum(cm.simulated_total) ? cm.simulated_total : null, measured_total: isNum(cm.measured_total) ? cm.measured_total : null, low: null, high: null, within_budget: null,
        breakdown: comps.filter(function (r) { return isNum(r.amount); }).map(function (r) { return { category: r.label || r.id, low: null, expected: r.amount, high: null, basis: r.rate_provenance === 'placeholder' ? 'placeholder' : kind, quantity: r.quantity, unit: r.unit, formula: r.formula }; }),
        energy: null, duration: null, equipment: null, notes: cm.note ? [cm.note] : [] };
    }
    return null;
  }
  function resourcesFrom(run, report, results) {
    var out = { energy: null, time: null, equipment: [], consumables: [], basis: 'simulated' };
    var rc = results && results.resource_consumption;
    if (rc) {
      var e = rc.energy || {}, t = rc.time || {};
      out.energy = { capacity_wh: first(e.usable_capacity_wh), start_wh: first(e.start_wh), end_wh: first(e.end_wh), lowest_wh: first(e.lowest_wh), reserve_wh: first(e.reserve_wh), used_wh: e.consumed_wh && isNum(e.consumed_wh.total) ? e.consumed_wh.total : null, generated_wh: first(e.generated_wh) };
      out.time = { elapsed_s: first(t.elapsed_s), limit_s: first(t.limit_s) };
      out.equipment = arr(rc.equipment); out.consumables = arr(rc.consumables);
    } else if (report && report.totals && report.totals.energy) {
      var te = report.totals.energy; out.energy = { capacity_wh: te.usable_capacity_wh, start_wh: te.start_wh, end_wh: te.end_wh, lowest_wh: te.min_wh, reserve_wh: te.reserve_wh, used_wh: te.consumed_wh && te.consumed_wh.total, generated_wh: te.generated_wh };
      out.time = { elapsed_s: report.totals.elapsed_s, limit_s: report.limits && report.limits.max_mission_s };
    } else if (run && run.cost && run.cost.energy) {
      var ce = run.cost.energy; out.energy = { capacity_wh: ce.capacity_wh, used_wh: ce.used_wh, lowest_wh: null, reserve_wh: null };
      out.time = { elapsed_s: run.summary && run.summary.duration_s, limit_s: run.cost.duration && run.cost.duration.limit_s };
    } else return null;
    return out;
  }

  // ---------------------------------------------------------------- outcome record
  var OUTCOME = {
    success: { label: 'Success', tone: 'ok', state: 'completed' }, success_with_caveats: { label: 'Success with caveats', tone: 'ok', state: 'completed' },
    partial: { label: 'Partial success', tone: 'warn', state: 'partial' }, failed: { label: 'Failed', tone: 'bad', state: 'failed' }, aborted: { label: 'Aborted', tone: 'bad', state: 'aborted' },
    halted: { label: 'Stopped by a failure', tone: 'bad', state: 'halted' }
  };
  function outcomeFrom(run, report, results) {
    if (run) {
      var s = run.summary || {}, o = OUTCOME[run.outcome] || { label: words(run.outcome), tone: 'warn', state: 'partial' };
      return { source: 'ui-run', key: run.outcome, label: o.label, tone: o.tone, state: o.state, reason: run.outcome_reason || null, objective_met: run.objective_met === true ? true : run.objective_met === false ? false : null,
        duration_s: s.duration_s, distance_m: s.distance_m, energy_used_wh: s.energy_used_wh, energy_margin_pct: s.energy_margin_pct, success_probability: first(s.success_probability), success_method: s.success_probability_method || null,
        risk: isObj(s.risk) ? { level: s.risk.level || null, score: first(s.risk.score) } : null, open_failures: first(s.open_failures), progress: null, objectives: [], criteria: [], confidence: null, confidence_note: null, loss_cause: run.loss_cause || null, basis: 'simulated' };
    }
    if (results || report) {
      var pr = (results && results.progress) || null, rp = report || null, sa = results && results.success_assessment;
      var verdict = sa && sa.verdict, key = verdict ? String(verdict).toLowerCase() : (rp ? (rp.status === 'completed' ? 'success' : rp.status === 'halted' ? 'halted' : null) : null);
      if (key === 'success_with_caveats') key = 'success_with_caveats';
      var o2 = OUTCOME[key] || (key ? { label: words(key), tone: 'warn', state: 'partial' } : { label: 'Unknown', tone: 'warn', state: 'partial' });
      var objs = results && results.objectives ? [].concat(arr(results.objectives.completed), arr(results.objectives.incomplete), arr(results.objectives.skipped)) : arr(rp && rp.objectives);
      var tot = rp && rp.totals;
      var rr = results && results.failures && results.failures.risk;
      return { source: results ? 'results' : 'simulation', key: key, label: o2.label, tone: o2.tone, state: o2.state, reason: sa && arr(sa.rationale).length ? sa.rationale.join(' ') : (rp && rp.halted ? rp.halted.message : null), objective_met: results && results.objectives ? (results.objectives.required_completed === results.objectives.required_total) : null,
        duration_s: first(pr && pr.elapsed_s, tot && tot.elapsed_s), distance_m: first(pr && pr.distance_in_plan_m, tot && tot.distance_in_plan_m), energy_used_wh: first(results && results.resource_consumption && results.resource_consumption.energy && results.resource_consumption.energy.consumed_wh && results.resource_consumption.energy.consumed_wh.total, tot && tot.energy && tot.energy.consumed_wh && tot.energy.consumed_wh.total),
        energy_margin_pct: null, success_probability: null, success_method: null, risk: rr && isNum(rr.index) ? { level: null, score: rr.index } : null, open_failures: results && results.failures ? results.failures.count : null,
        progress: first(pr && pr.progress_fraction, tot && tot.progress_fraction), objectives: objs.map(function (x) { return { id: x.id, label: x.label || x.id, required: !!x.required, status: x.status || null, t_s: first(x.completed_t_s) }; }),
        criteria: arr(sa && sa.criteria), confidence: sa ? sa.confidence : null, confidence_note: sa ? sa.confidence_note : null, loss_cause: rp && rp.halted ? rp.halted.code : null, basis: 'simulated' };
    }
    return null;
  }

  // ---------------------------------------------------------------- route + phases
  /** Route legs/waypoints in one shape: { source, basis, waypoints:[{id,label,kind,lon,lat,t_s}], legs:[{id,from,to,distance_m,duration_s,energy_wh,max_grade_deg,risk_index}], dwell_s_each, planned:boolean } */
  function routeFromEngine(plan, k) {
    var s = plan && plan.strategies && plan.strategies[k]; if (!s || !s.route || s.route.status !== 'ok') return null;
    var rt = s.route, legs = arr(rt.legs), sites = arr(s.sites), byRow = {};
    sites.forEach(function (x) { if (x.location) byRow[x.location.row_index] = x; });
    var dwellH = plan.mission && plan.mission.config && plan.mission.config.objectives ? plan.mission.config.objectives.siteDwellH : null;
    var start = rt.start || {}, wps = [{ id: 'start', label: 'Staging start', kind: 'start', lon: start.lon_deg, lat: start.lat_deg, row_index: start.row_index }];
    legs.forEach(function (l, i) {
      var site = byRow[l.to_row_index], rank = site && site.similarity ? site.similarity.rank : null, score = site && site.similarity ? site.similarity.score : null;
      var g = arr(rt.goals).filter(function (x) { return x.row_index === l.to_row_index; })[0] || (site && site.location) || {};
      wps.push({ id: 'site' + (i + 1), label: 'Site ' + (i + 1), kind: 'site', lon: g.lon_deg, lat: g.lat_deg, row_index: l.to_row_index, similarity: score, similarity_rank: rank });
    });
    return { source: 'engine-plan', basis: 'estimate', strategy: k, planned: true, dwell_s_each: isNum(dwellH) ? dwellH * 3600 : null, dwell_basis: 'assumption',
      waypoints: wps, legs: legs.map(function (l, i) { return { id: 'L' + l.leg, from: wps[i].id, to: wps[i + 1] ? wps[i + 1].id : null, distance_m: l.distance_m, duration_s: isNum(l.est_drive_time_h) ? l.est_drive_time_h * 3600 : null, energy_wh: l.est_energy_wh, max_grade_deg: l.max_travel_grade_deg, risk_index: l.route_risk_index }; }) };
  }
  function routeFromUi(r, tag, planned) {
    if (!r || !arr(r.waypoints).length) return null;
    var wps = r.waypoints.map(function (w, i) { return { id: String(w.id), label: w.label || String(w.id), kind: w.kind || (i === 0 ? 'start' : null), lon: w.point ? w.point.lon_deg : null, lat: w.point ? w.point.lat_deg : null, t_s: isNum(w.planned_t_s) ? w.planned_t_s : null }; });
    return { source: tag, basis: planned ? 'estimate' : 'simulated', planned: !!planned, dwell_s_each: null, waypoints: wps,
      legs: arr(r.legs).map(function (l, i) { return { id: String(l.id), from: l.from != null ? String(l.from) : (wps[i] ? wps[i].id : null), to: l.to != null ? String(l.to) : (wps[i + 1] ? wps[i + 1].id : null), distance_m: l.distance_m, duration_s: l.duration_s, energy_wh: l.energy_wh, max_grade_deg: l.max_grade_deg, risk_index: null }; }) };
  }

  var PH_STATES = ['completed', 'active', 'pending', 'failed', 'not_reached', 'skipped', 'planned'];
  /**
   * Mission phases in sequence. Each: { id, seq, kind:'transit'|'work'|'start'|'end', title, subtitle, from_t_s, to_t_s, duration_s, distance_m, state, basis, failures:[ids], note }
   * `mode` 'outcome' = final state of the run; 'replay' = state at playback time t (contract-1.0 runs only).
   */
  function phasesFromSim(report, results) {
    var segs = arr(report.segments), objs = {}, halted = report.halted || null, out = [], seq = 0;
    arr(report.objectives).forEach(function (o) { objs[o.waypoint_id] = o; });
    out.push({ id: 'ph-start', seq: ++seq, kind: 'start', title: 'Mission start', subtitle: arr(report.waypoints)[0] ? 'At ' + (report.waypoints[0].id) : null, from_t_s: 0, to_t_s: 0, duration_s: 0, distance_m: null, state: 'completed', basis: 'simulated', failures: [] });
    segs.forEach(function (sg, i) {
      var st = sg.status === 'completed' ? 'completed' : sg.status === 'in_progress' ? 'failed' : (sg.status === 'blocked' || sg.status === 'halted') ? 'failed' : 'not_reached';
      var haltHere = halted && halted.segment_index === i; if (haltHere) st = 'failed';
      out.push({ id: 'ph-t' + i, seq: ++seq, kind: 'transit', title: 'Drive ' + (sg.from || '?') + ' → ' + (sg.to || '?'), subtitle: isNum(sg.traveled_m) && sg.traveled_m < sg.length_m ? 'Covered ' + fmtDist(sg.traveled_m) + ' of ' + fmtDist(sg.length_m) : null,
        from_t_s: sg.started_t_s, to_t_s: st === 'completed' ? sg.finished_t_s : (haltHere && halted ? halted.t_s : null), duration_s: isNum(sg.time_s) && sg.time_s > 0 ? sg.time_s : null, planned_duration_s: sg.nominal_time_s, distance_m: sg.length_m, state: st, basis: 'simulated',
        failures: haltHere && halted ? [halted.code] : [], note: haltHere && halted ? halted.message : null });
      var ob = objs[sg.to];
      if (ob) {
        var ost = ob.status === 'completed' ? 'completed' : ob.status === 'skipped' ? 'skipped' : (st === 'completed' ? 'not_reached' : 'not_reached');
        out.push({ id: 'ph-w' + i, seq: ++seq, kind: 'work', title: (ob.label || ob.id) + ' at ' + sg.to, subtitle: (ob.required ? 'Required' : 'Optional') + ' objective', from_t_s: ost === 'completed' && isNum(ob.completed_t_s) && isNum(ob.dwell_s) ? ob.completed_t_s - ob.dwell_s : null, to_t_s: ost === 'completed' ? ob.completed_t_s : null,
          duration_s: ost === 'completed' ? ob.dwell_s : null, planned_duration_s: ob.dwell_s, distance_m: null, state: ost, basis: 'simulated', failures: [] });
      }
    });
    var done = report.status === 'completed';
    out.push({ id: 'ph-end', seq: ++seq, kind: 'end', title: done ? 'Mission complete' : 'Mission ended', subtitle: done ? null : (halted ? 'Stopped: ' + words(halted.code) : null), from_t_s: report.totals ? report.totals.elapsed_s : null, to_t_s: report.totals ? report.totals.elapsed_s : null, duration_s: 0, distance_m: null, state: done ? 'completed' : 'failed', basis: 'simulated', failures: [] });
    return out;
  }
  function phasesFromRoute(rt, strategyLabel) {
    var out = [], seq = 0, wp = {}; arr(rt.waypoints).forEach(function (w) { wp[w.id] = w; });
    var t = 0, timed = true, i, planned = !!rt.planned;
    out.push({ id: 'ph-start', seq: ++seq, kind: 'start', title: 'Mission start', subtitle: wp[rt.waypoints[0].id] ? rt.waypoints[0].label : null, from_t_s: 0, to_t_s: 0, duration_s: 0, distance_m: null, state: planned ? 'planned' : 'pending', basis: rt.basis, failures: [] });
    arr(rt.legs).forEach(function (l, k) {
      var a = wp[l.from], b = wp[l.to], startT = null;
      if (timed && isNum(l.duration_s)) { startT = (a && isNum(a.t_s) && !planned) ? a.t_s : t; } else timed = false;
      var endT = startT != null ? startT + l.duration_s : null;
      out.push({ id: 'ph-t' + k, seq: ++seq, kind: 'transit', title: 'Drive to ' + (b ? b.label : 'next waypoint'), subtitle: a && b ? a.label + ' → ' + b.label : null, from_t_s: startT, to_t_s: endT, duration_s: l.duration_s, distance_m: l.distance_m,
        state: planned ? 'planned' : 'pending', basis: rt.basis, failures: [], note: isNum(l.max_grade_deg) ? 'Steepest grade ' + num(l.max_grade_deg, 1) + '°' : null });
      if (endT != null) t = endT;
      if (b && planned && isNum(rt.dwell_s_each) && b.kind === 'site') {
        var w0 = timed ? t : null, w1 = timed ? t + rt.dwell_s_each : null;
        out.push({ id: 'ph-w' + k, seq: ++seq, kind: 'work', title: 'Work at ' + b.label, subtitle: isNum(b.similarity) ? 'Similarity ' + num(b.similarity, 1) + ' (model output)' : null, from_t_s: w0, to_t_s: w1, duration_s: rt.dwell_s_each, distance_m: null, state: 'planned', basis: rt.dwell_basis || 'assumption', failures: [], note: 'Dwell time is an assumption of the planning engine.' });
        if (timed) t = w1;
      }
    });
    out.push({ id: 'ph-end', seq: ++seq, kind: 'end', title: 'Mission end', subtitle: null, from_t_s: timed ? t : null, to_t_s: timed ? t : null, duration_s: 0, distance_m: null, state: planned ? 'planned' : 'pending', basis: rt.basis, failures: [] });
    // gaps between legs in a run (dwell that the contract does not name): derive from planned waypoint times
    if (!planned) {
      var res = [], pushed = {};
      out.forEach(function (p, idx) {
        res.push(p);
        var nxt = out[idx + 1];
        if (p.kind === 'transit' && nxt && nxt.kind === 'transit' && isNum(p.to_t_s) && isNum(nxt.from_t_s) && nxt.from_t_s - p.to_t_s > 1) {
          res.push({ id: 'ph-g' + idx, seq: 0, kind: 'work', title: 'Stop at ' + (p.title.replace(/^Drive to /, '')), subtitle: 'Time between legs, derived from planned times', from_t_s: p.to_t_s, to_t_s: nxt.from_t_s, duration_s: nxt.from_t_s - p.to_t_s, distance_m: null, state: 'pending', basis: 'estimate', failures: [] });
        }
      });
      res.forEach(function (p, idx) { p.seq = idx + 1; }); return res;
    }
    return out;
  }
  /** Apply replay time or final outcome to route-derived phases of a contract-1.0 run. */
  function applyRunProgress(phases, run, mode, t, failures) {
    var tEnd = arr(run.timeline && run.timeline.samples).length ? run.timeline.samples[run.timeline.samples.length - 1].t_s : null;
    var lossT = null; arr(failures).forEach(function (f) { if (f.caused_loss && isNum(f.t_s)) lossT = lossT == null ? f.t_s : Math.min(lossT, f.t_s); });
    if (lossT == null && (run.outcome === 'failed' || run.outcome === 'aborted') && isNum(tEnd)) lossT = tEnd;
    phases.forEach(function (p) {
      var f = arr(failures).filter(function (x) { return isNum(x.t_s) && isNum(p.from_t_s) && x.t_s >= p.from_t_s && (isNum(p.to_t_s) ? x.t_s <= p.to_t_s : false); });
      p.failures = f.map(function (x) { return x.id; });
      if (!isNum(p.from_t_s)) { p.state = 'pending'; return; }
      var end = isNum(p.to_t_s) ? p.to_t_s : p.from_t_s;
      if (mode === 'replay') {
        p.state = t >= end && (p.kind === 'start' ? true : t >= end) ? 'completed' : (t >= p.from_t_s ? 'active' : 'pending');
        if (p.kind === 'start') p.state = t > 0 || t >= end ? 'completed' : 'active';
        if (lossT != null && p.from_t_s > lossT) p.state = 'not_reached';
        if (lossT != null && t >= lossT && p.from_t_s <= lossT && end >= lossT) p.state = f.length ? 'failed' : p.state;
      } else {
        p.state = 'completed';
        if (lossT != null) { if (p.from_t_s > lossT) p.state = 'not_reached'; else if (end >= lossT && p.kind !== 'start') p.state = 'failed'; }
        if (lossT == null && f.some(function (x) { return x.severity === 'critical'; })) p.state = 'completed';
      }
    });
    return { tEnd: tEnd, lossT: lossT };
  }

  // ---------------------------------------------------------------- setup (configuration) rows
  function setupFrom(src, ui, shellSetup) {
    var s = isObj(src.setup) ? src.setup : (ui && ui.setup) || shellSetup || null, plan = src.plan, cfg = plan && plan.mission && plan.mission.config, rows = [];
    var add = function (group, label, value, basis, unit) { if (value === null || value === undefined || value === '') return; rows.push({ group: group, label: label, value: String(value), basis: basisOf(basis) || null, unit: unit || null }); };
    var out = { name: null, objective: null, body: null, operating_body: null, target_body: null, site: null, strategy: null, rows: rows };
    if (s) {
      out.name = s.name || null; out.objective = s.objective && s.objective.text || null; out.body = s.destination || null; out.strategy = stratKey(s.strategy);
      add('Mission', 'Name', s.name, 'user'); add('Mission', 'Objective', s.objective && s.objective.text, 'user'); add('Mission', 'Success criterion', s.objective && s.objective.success_criterion, 'user');
      add('Mission', 'Priority', s.objective && s.objective.priority && cap(s.objective.priority), 'user'); add('Mission', 'Random seed', isNum(s.seed) ? s.seed : null, 'user');
      var v = s.vehicle || {};
      add('Vehicle', 'Name', v.name, 'user'); add('Vehicle', 'Mass', isNum(v.mass_kg) ? num(v.mass_kg, 1) + ' kg' : null, 'user'); add('Vehicle', 'Maximum slope', isNum(v.max_slope_deg) ? num(v.max_slope_deg, 1) + '°' : null, 'user');
      add('Vehicle', 'Flat-ground speed', isNum(v.speed_mps_flat) ? num(v.speed_mps_flat, 2) + ' m/s' : null, 'user'); add('Vehicle', 'Average power', isNum(v.power_w) ? num(v.power_w, 0) + ' W' : null, 'user'); add('Vehicle', 'Battery', isNum(v.battery_wh) ? num(v.battery_wh, 0) + ' Wh' : null, 'user');
      arr(s.equipment).forEach(function (e) { add('Equipment', e.name || 'Item', [isNum(e.mass_kg) ? num(e.mass_kg, 1) + ' kg' : null, isNum(e.power_w) ? num(e.power_w, 0) + ' W' : null].filter(Boolean).join(' · ') || 'listed', 'user'); });
      var c = s.constraints || {};
      add('Limits', 'Budget limit', isNum(c.max_cost) ? num(c.max_cost, 2) + (c.currency ? ' ' + c.currency : '') : null, 'user'); add('Limits', 'Duration limit', isNum(c.max_duration_s) ? fmtDur(c.max_duration_s) : null, 'user'); add('Limits', 'Minimum battery reserve', isNum(c.min_battery_pct) ? num(c.min_battery_pct, 0) + ' %' : null, 'user');
      if (s.site) out.site = { source: s.site.source || null, lon: s.site.lon_deg, lat: s.site.lat_deg, row_index: s.site.csv_row_index == null ? null : s.site.csv_row_index };
    }
    if (cfg) {
      out.target_body = cfg.targetBody || null; out.operating_body = cfg.operatingBody || null; out.body = out.body || cfg.operatingBody || null; if (!out.name && cfg.name) out.name = cfg.name;
      var pm = plan.mission, ph = pm && pm.placeholder_rover_params || [];
      add('Mission', 'Analog target', cfg.targetBody && cap(cfg.targetBody), 'user'); add('Mission', 'Route grid scale', isNum(cfg.routeScaleM) ? cfg.routeScaleM + ' m' : null, 'assumption');
      add('Mission', 'Science stops requested', cfg.objectives && cfg.objectives.numScienceStops, 'assumption'); add('Mission', 'Site dwell time', cfg.objectives && isNum(cfg.objectives.siteDwellH) ? cfg.objectives.siteDwellH + ' h' : null, 'assumption');
      var r = cfg.rover || {}; if (!s || !s.vehicle) {
        var rb = function (k) { return ph.indexOf(k) >= 0 ? 'placeholder' : 'user'; };
        add('Vehicle', 'Mass', isNum(r.massKg) ? r.massKg + ' kg' : null, rb('massKg')); add('Vehicle', 'Nominal speed', isNum(r.nominalSpeedMps) ? r.nominalSpeedMps + ' m/s' : null, rb('nominalSpeedMps'));
        add('Vehicle', 'Base power', isNum(r.basePowerW) ? r.basePowerW + ' W' : null, rb('basePowerW'));
      }
      var k = cfg.constraints || {}, rs = cfg.resources || {};
      add('Limits', 'Maximum slope', isNum(k.maxSlopeDeg) ? k.maxSlopeDeg + '°' : null, 'user'); add('Limits', 'Maximum roughness', isNum(k.maxRoughnessM) ? k.maxRoughnessM + ' m' : null, 'user');
      add('Limits', 'Time budget', isNum(rs.timeBudgetH) ? rs.timeBudgetH + ' h' : null, 'user'); add('Limits', 'Energy budget', isNum(rs.energyBudgetWh) ? rs.energyBudgetWh + ' Wh' : null, 'user'); add('Limits', 'Energy reserve', isNum(rs.energyReserveFraction) ? Math.round(rs.energyReserveFraction * 100) + ' %' : null, 'assumption');
      var pr = cfg.priorities; if (pr) add('Mission', 'Priorities (speed / safety / science)', [pr.speed, pr.safety, pr.science].map(function (x) { return isNum(x) ? x.toFixed(2) : NA; }).join(' / '), 'user');
    }
    var ep = plan && plan.context; if (ep) { out.operating_body = out.operating_body || ep.operating_body; out.target_body = out.target_body || ep.target_body; }
    out.has = rows.length > 0 || !!out.name;
    return out;
  }

  // ==================================================================================================
  //  BUNDLE
  // ==================================================================================================
  var store = { explicit: {}, subs: [], timer: null, last: '', bound: false };

  function uiMission() { var f = root && root.FZ; return f && isObj(f.mission) ? f.mission : null; }
  function shellSetup() { try { return root && root.FZShell && typeof root.FZShell.getSetup === 'function' ? root.FZShell.getSetup() : null; } catch (e) { return null; } }
  function recoveryLabels(ui) { var c = ui && ui.engine && ui.engine.catalog, m = {}; arr(c && c.recoveries).forEach(function (r) { m[r.id] = r.label || r.id; }); return m; }

  /** Build the normalised, read-only bundle from explicit input plus window.FZ.mission. Pure given its inputs. */
  function build(input, opts) {
    opts = opts || {}; input = input || {};
    var ui = opts.ui === undefined ? uiMission() : opts.ui;
    var src = {
      plan: isEnginePlan(input.plan) ? input.plan : null,
      uiPlan: isUiPlan(input.uiPlan) ? input.uiPlan : (ui && isUiPlan(ui.plan) ? ui.plan : null),
      results: isResults(input.results) ? input.results : null, report: isReport(input.report) ? input.report : null,
      failure: isObj(input.failure) ? input.failure : null, cost: isObj(input.cost) ? input.cost : null, scenarios: isObj(input.scenarios) ? input.scenarios : null, setup: input.setup || null
    };
    var runs = {}, uiRuns = ui ? ui.runs || {} : {};
    Object.keys(uiRuns).forEach(function (k) { if (isUiRun(uiRuns[k])) runs[k] = uiRuns[k]; });
    arr(input.runs).forEach(function (r) { if (isUiRun(r)) runs[r.run_id] = r; });
    if (isUiRun(input.run)) runs[input.run.run_id] = input.run;
    var nomId = input.run && isUiRun(input.run) ? input.run.run_id : (ui && ui.nominal_run_id && runs[ui.nominal_run_id] ? ui.nominal_run_id : null);
    if (!nomId) Object.keys(runs).forEach(function (k) { if (!nomId && runs[k].kind === 'nominal') nomId = k; });
    var actId = ui && ui.active_run_id && runs[ui.active_run_id] ? ui.active_run_id : nomId;
    var nominal = nomId ? runs[nomId] : null, active = actId ? runs[actId] : nominal;
    var labels = recoveryLabels(ui);
    var results = src.results, report = src.report || null;
    var shell = opts.shell === undefined ? shellSetup() : opts.shell;
    var setup = setupFrom(src, ui, shell);
    var selected = stratKey(input.selectedStrategy) || stratKey(ui && ui.strategy) || setup.strategy || (nominal ? stratKey(nominal.strategy) : null);
    var strategies = normalizeStrategies(src);
    if (!selected) selected = strategies.recommended;
    var fixture = null;
    if (nominal && nominal.provenance && typeof nominal.provenance.fixture === 'boolean') fixture = nominal.provenance.fixture;
    else if (ui && typeof ui.fixture === 'boolean') fixture = ui.fixture;
    else if (src.uiPlan && src.uiPlan.provenance && typeof src.uiPlan.provenance.fixture === 'boolean') fixture = src.uiPlan.provenance.fixture;

    // ---- events (the run being looked at: the active contract-1.0 run, else the simulation report)
    var events = [], eventSource = null, runForEvents = active;
    if (runForEvents) { events = eventsFromUiRun(runForEvents, runForEvents.run_id, labels); eventSource = 'ui-run:' + runForEvents.run_id; }
    else if (report || results || src.failure) { events = eventsFromSim(report, src.failure, results, 'sim'); eventSource = 'simulation'; }
    events = sortEvents(events);

    // ---- result record, failures, cost, resources
    var outcome = outcomeFrom(runForEvents, report, results);
    var failures = failuresFrom(runForEvents, src.failure, results, labels);
    var cost = costFrom(runForEvents, src.cost, results, src.uiPlan && src.uiPlan.currency);
    var resources = resourcesFrom(runForEvents, report, results);

    // ---- scenarios
    var scenarios = [];
    if (ui && arr(ui.scenarios).length) arr(ui.scenarios).forEach(function (sc) {
      var r = runs[sc.run_id], b = runs[sc.baseline_run_id]; if (!r || !b) return;
      scenarios.push({ name: sc.name, injection: sc.scenario && sc.scenario.injection || null, recovery: sc.scenario && sc.scenario.recovery ? (labels[sc.scenario.recovery] || sc.scenario.recovery) : null,
        outcome: (OUTCOME[r.outcome] || {}).label || r.outcome, baseline_outcome: (OUTCOME[b.outcome] || {}).label || b.outcome, d_duration_s: r.summary.duration_s - b.summary.duration_s,
        d_cost: isObj(r.cost) && isObj(b.cost) && isNum(r.cost.expected) && isNum(b.cost.expected) ? r.cost.expected - b.cost.expected : null,
        d_success: isNum(r.summary.success_probability) && isNum(b.summary.success_probability) ? r.summary.success_probability - b.summary.success_probability : null, basis: 'simulated' });
    });
    var scn = src.scenarios || (results && results.scenarios) || null;
    if (!scenarios.length && scn && arr(scn.items).length) scn.items.forEach(function (it) {
      var d = it.delta_vs_baseline || {};
      scenarios.push({ name: it.name || it.id, injection: arr(it.changes_applied).map(function (c) { return c.path || c.change || c.id || JSON.stringify(c); }).join(', ') || null, recovery: null,
        outcome: it.outcome_change ? words(it.outcome_change.scenario) : null, baseline_outcome: it.outcome_change ? words(it.outcome_change.baseline) : null,
        d_duration_s: d.elapsed_s ? d.elapsed_s.delta : null, d_cost: d.cost_simulated_total ? d.cost_simulated_total.delta : null, d_success: null, d_progress: d.progress_fraction ? d.progress_fraction.delta : null, basis: 'simulated' });
    });

    // ---- route and phases
    var phases = [], route = null, mode = 'plan', phaseNote = null, timing = null, selForRoute = selected || strategies.recommended || STRATS.filter(function (k) { return strategies.items[k].present; })[0] || null;
    var pb = input.playback || (ui && ui.playback) || null, t = pb && isNum(pb.t_s) ? pb.t_s : 0;
    if (report && report.segments && report.segments.length && !runForEvents) {
      phases = phasesFromSim(report, results); route = null; mode = 'outcome'; timing = { tEnd: report.totals ? report.totals.elapsed_s : null };
    } else if (runForEvents && (routeFromUi(runForEvents.route, 'ui-run', false))) {
      route = routeFromUi(runForEvents.route, 'ui-run', false); phases = phasesFromRoute(route);
      var tr = (pb && (pb.playing || t > 0)); mode = tr ? 'replay' : 'outcome';
      timing = applyRunProgress(phases, runForEvents, mode, t, failures);
    } else if (selForRoute && src.plan) {
      route = routeFromEngine(src.plan, selForRoute); if (route) { phases = phasesFromRoute(route); mode = 'plan'; }
    } else if (selForRoute && src.uiPlan && src.uiPlan.strategies[selForRoute.toLowerCase()] && src.uiPlan.strategies[selForRoute.toLowerCase()].feasible) {
      route = routeFromUi(src.uiPlan.strategies[selForRoute.toLowerCase()].route, 'ui-plan', true); if (route) { phases = phasesFromRoute(route); mode = 'plan'; }
    }
    phases.forEach(function (p) { p.event_ids = []; });
    if (phases.length && events.length) events.forEach(function (e) {
      if (!isNum(e.t_s)) return;
      var hit = phases.filter(function (p) { return isNum(p.from_t_s) && e.t_s >= p.from_t_s && (isNum(p.to_t_s) ? e.t_s <= p.to_t_s : e.t_s === p.from_t_s); });
      var p = hit.filter(function (x) { return x.kind !== 'start' && x.kind !== 'end'; })[0] || hit[0]; if (p) p.event_ids.push(e.id);
    });

    // ---- mission state
    var state = 'empty', stateNote = null;
    if (phases.length || strategies.available || outcome) {
      state = 'planned';
      if (outcome) {
        if (mode === 'replay' && pb) {
          var endT = timing && isNum(timing.tEnd) ? timing.tEnd : null;
          state = pb.playing ? 'running' : (endT != null && t >= endT ? outcome.state : 'paused');
          stateNote = mode === 'replay' && state !== outcome.state ? 'Replay position ' + fmtClock(t) + (endT != null ? ' of ' + fmtClock(endT) : '') + '. Final outcome: ' + outcome.label + '.' : null;
        } else state = outcome.state;
      } else if (runForEvents == null && src.plan) state = 'planned';
    } else if (setup.has) state = 'configured';

    // ---- limitations, assumptions, gaps, provenance
    var lims = [], seenL = {};
    var addLim = function (l) { var key = l && (l.id || l.statement || l); if (!key || seenL[key]) return; seenL[key] = 1; lims.push(typeof l === 'string' ? { id: null, severity: null, category: null, statement: l, effect: null } : { id: l.id || null, severity: l.severity || null, category: l.category || null, statement: l.statement || l.message || String(l), effect: l.effect || null }); };
    var selPlan = src.plan && selForRoute && src.plan.strategies[selForRoute];
    arr(src.plan && src.plan.data_limitations).forEach(addLim); arr(selPlan && selPlan.data_limitations).forEach(addLim);
    arr(results && results.data_limitations).forEach(addLim); arr(src.failure && src.failure.limitations).forEach(addLim);
    if (runForEvents) arr(runForEvents.limitations).forEach(addLim); if (src.uiPlan) arr(src.uiPlan.limitations).forEach(addLim);
    var order = { critical: 0, major: 1, minor: 2 }; lims.sort(function (a, b) { return (order[a.severity] == null ? 3 : order[a.severity]) - (order[b.severity] == null ? 3 : order[b.severity]); });
    var ass = [], seenA = {}; var addAss = function (a) { if (a == null) return; var s = typeof a === 'string' ? a : (a.statement || a.message || a.description || JSON.stringify(a)); if (!seenA[s]) { seenA[s] = 1; ass.push(s); } };
    arr(src.plan && src.plan.assumptions_and_estimates).forEach(addAss); arr(results && results.assumptions).forEach(addAss); arr(src.failure && src.failure.assumptions).forEach(addAss);
    if (runForEvents) arr(runForEvents.assumptions).forEach(addAss); if (src.uiPlan) arr(src.uiPlan.assumptions).forEach(addAss);
    var gaps = src.plan && src.plan.evidence_gaps ? { counts: src.plan.evidence_gaps.counts || null, note: src.plan.evidence_gaps.note || null, items: arr(src.plan.evidence_gaps.items).map(function (g) { return { variable: g.variable, body: g.body, status: g.status, cannot_conclude: g.cannot_conclude }; }) } : null;
    var prov = [];
    if (src.plan) prov.push(['Planning engine', 'v' + (src.plan.meta && src.plan.meta.engine_version || '?') + ' · schema ' + (src.plan.meta && src.plan.meta.schema_version || '?')]);
    if (results) prov.push(['Results module', results.contract + ' v' + results.version + (results.deterministic ? ' · deterministic' : '')]);
    if (report) prov.push(['Simulation report', report.contract]);
    if (runForEvents) { prov.push(['Run', runForEvents.run_id + (runForEvents.engine_version ? ' · engine ' + runForEvents.engine_version : '') + (isNum(runForEvents.seed_used) ? ' · seed ' + runForEvents.seed_used : '')]); if (runForEvents.provenance && arr(runForEvents.provenance.terrain).length) prov.push(['Terrain datasets', runForEvents.provenance.terrain.join(', ')]); }
    if (results) arr(results.provenance).forEach(function (p) { if (p && p.item) prov.push([p.item, [p.class, p.detail].filter(Boolean).join(' · ')]); });
    var context = src.plan && src.plan.context ? src.plan.context : null;
    var sites = sitesFrom(src.plan, selForRoute, src.uiPlan, setup);
    var objectiveText = setup.objective;

    return {
      version: VERSION, state: state, state_note: stateNote, fixture: fixture, selected: selected, recommended: strategies.recommended,
      setup: setup, strategies: strategies, route: route, route_strategy: selForRoute, phases: phases, phase_mode: mode, timing: timing, playback: pb ? { t_s: t, playing: !!pb.playing, speed: pb.speed || 1 } : null,
      events: events, event_source: eventSource, outcome: outcome, failures: failures, cost: cost, resources: resources, scenarios: scenarios, sites: sites, context: context,
      limitations: lims, assumptions: ass, gaps: gaps, provenance: prov, label: src.plan && src.plan.label || null, disclaimer: src.plan && src.plan.disclaimer || null,
      sources: { engine_plan: !!src.plan, ui_plan: !!src.uiPlan, ui_run: !!runForEvents, results: !!results, report: !!report, failure: !!src.failure, cost: !!src.cost, scenarios: !!scn },
      objective_text: objectiveText
    };
  }
  /** Selected sites: ranked list from the engine plan for the strategy, else the contract-1.0 resolved site, else the builder site. */
  function sitesFrom(plan, k, uiPlan, setup) {
    var out = [], s = plan && k && plan.strategies[k];
    if (s && arr(s.sites).length) {
      var visited = {}; arr(s.visited_sites).forEach(function (r) { visited[r] = true; });
      arr(s.sites).forEach(function (x, i) {
        var l = x.location || {}, sim = x.similarity || {}, su = x.suitability || {}, rk = x.risk || {}, cf = x.confidence || {};
        out.push({ rank: i + 1, row_index: l.row_index, lon: l.lon_deg, lat: l.lat_deg, elevation_m: l.elevation_m, visited: !!visited[l.row_index],
          similarity: isNum(sim.score) ? sim.score : null, similarity_rank: sim.rank, similarity_target: sim.target || null, scale_consistency: sim.scale_check ? sim.scale_check.consistency : null, score_360m: sim.scale_check ? sim.scale_check.score_360m : null,
          suitability: first(su.index, su.score), risk: first(rk.index, rk.score), risk_class: rk.class || null, confidence: cf.level || sim.similarity_engine_confidence || null, label: sim.status_label || null, basis: 'model' });
      });
    } else if (uiPlan && uiPlan.site_resolved) {
      var r = uiPlan.site_resolved; out.push({ rank: 1, row_index: first(r.row_index, r.csv_row_index), lon: r.lon_deg, lat: r.lat_deg, elevation_m: r.elevation_m, visited: true, similarity: null, label: 'Resolved by the engine', basis: 'estimate' });
    } else if (setup && setup.site && isNum(setup.site.lon)) out.push({ rank: 1, row_index: setup.site.row_index, lon: setup.site.lon, lat: setup.site.lat, elevation_m: null, visited: true, similarity: null, label: 'Entered in the builder (' + (setup.site.source || 'unknown source') + ')', basis: 'user' });
    return out;
  }

  // ==================================================================================================
  //  STORE / SYNC
  // ==================================================================================================
  function setMission(input) {
    if (input === null || input === undefined) store.explicit = {};
    else if (isObj(input)) Object.keys(input).forEach(function (k) { store.explicit[k] = input[k]; });
    notify(true); return api;
  }
  /** Current bundle. `overrides` (optional) replaces explicit keys for this call only, e.g. { selectedStrategy: 'SAFE' } to preview another plan. */
  function getBundle(overrides) { return build(overrides ? Object.assign({}, store.explicit, overrides) : store.explicit); }
  function signature() {
    var f = root && root.FZ, m = f && f.mission, e = store.explicit, parts = [];
    parts.push(Object.keys(e).map(function (k) { var v = e[k]; return k + ':' + (isObj(v) ? (v.run_id || v.plan_id || v.contract || Object.keys(v).length) : (Array.isArray(v) ? v.length : String(v))); }).join(','));
    if (m) {
      parts.push(m.status, m.nominal_run_id, m.active_run_id, m.strategy, m.fixture, arr(m.scenarios).length, m.plan ? (m.plan.plan_id || 'plan') : '-', Object.keys(m.runs || {}).length);
      var r = m.runs && m.runs[m.active_run_id]; if (r) parts.push(arr(r.events).length, arr(r.failures).length);
    }
    return parts.join('|');
  }
  function subscribe(fn) { store.subs.push(fn); startSync(); return function () { store.subs = store.subs.filter(function (x) { return x !== fn; }); if (!store.subs.length) stopSync(); }; }
  function notify(force) {
    var sig = signature(), pbT = (function () { var m = uiMission(); return m && m.playback ? Math.round((m.playback.t_s || 0) * 2) + (m.playback.playing ? 'p' : 's') : ''; })();
    if (!force && sig === store.last.sig && pbT === store.last.pb) return;
    var dataChanged = force || sig !== store.last.sig; store.last = { sig: sig, pb: pbT };
    var b; try { b = getBundle(); } catch (err) { if (root.console) root.console.error('FZExtras: could not build the mission bundle', err); return; }
    store.subs.slice().forEach(function (fn) { try { fn(b, { dataChanged: dataChanged }); } catch (err2) { if (root.console) root.console.error('FZExtras subscriber failed', err2); } });
  }
  function startSync() {
    if (store.timer || !root || typeof root.setInterval !== 'function') return;
    store.timer = root.setInterval(function () { if (doc() && doc().hidden) return; notify(false); }, 400);
    if (!store.bound && doc()) {
      store.bound = true;
      doc().addEventListener('fz:mission-data', function (e) { if (e && isObj(e.detail)) setMission(e.detail); });
      ['fz:mission-launch', 'fz:strategy-select', 'fz:rehearsal-control', 'fz:whatif-run'].forEach(function (n) { doc().addEventListener(n, function () { root.setTimeout(function () { notify(false); }, 60); }); });
    }
  }
  function stopSync() { if (store.timer && root.clearInterval) { root.clearInterval(store.timer); store.timer = null; } }

  // ------------------------------------------------------------------ shared view scaffolding
  /** Find or create the host element for a view. Returns { host, created }. */
  function resolveHost(target, id, cfg) {
    var d = doc(); if (!d) return null;
    var el = typeof target === 'string' ? d.querySelector(target) : target;
    if (el) return { host: el, created: false };
    el = d.getElementById(id); if (el) return { host: el, created: false };
    if (!cfg || cfg.insert === false) return null;
    var ref = cfg.after && d.getElementById(cfg.after), main = d.getElementById('main') || d.body;
    var sec = h('section', { id: id, class: 'chapter fzx-chapter', 'data-fzx-tag': cfg.tag || 'Extra', 'aria-labelledby': id + '-h' });
    if (ref && ref.parentNode) ref.parentNode.insertBefore(sec, cfg.before ? ref : ref.nextSibling); else main.appendChild(sec);
    var rail = d.getElementById('rail');
    if (rail && cfg.rail !== false && !rail.querySelector('a[href="#' + id + '"]')) {
      var a = h('a', { href: '#' + id, class: 'sub', text: cfg.railLabel || cfg.title }), anchor = ref ? rail.querySelector('a[href="#' + cfg.after + '"]') : null;
      if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(a, cfg.before ? anchor : anchor.nextSibling); else rail.appendChild(a);
    }
    return { host: sec, created: true };
  }
  function frame(host, id, title, lede, created) {
    if (created || !host.querySelector('[data-fzx-frame]')) {
      clear(host);
      var head = h('div', { 'data-fzx-frame': '1' }, [h('h2', { class: 'big', id: id + '-h', text: title }), lede ? h('p', { class: 'lede', text: lede }) : null]);
      host.appendChild(head);
    }
    var body = host.querySelector('.fzx-body'); if (!body) { body = h('div', { class: 'fzx-body' }); host.appendChild(body); }
    return body;
  }

  /** Mount every extras view that is loaded, in page order. options: { timeline, eventLog, comparison, dossier } each false | {insert:false,...}. */
  function autoMount(options) {
    options = options || {}; var out = {};
    [['comparison', 'FZComparison'], ['timeline', 'FZTimeline'], ['eventLog', 'FZEventLog'], ['dossier', 'FZDossierView']].forEach(function (p) {
      var o = options[p[0]], mod = root[p[1]]; if (o === false || !mod || typeof mod.mount !== 'function') return;
      try { out[p[0]] = mod.mount(null, o || {}); } catch (e) { if (root.console) root.console.error('FZExtras.autoMount: ' + p[1] + ' failed', e); }
    });
    return out;
  }

  var api = {
    version: VERSION, autoMount: autoMount, NA: NA, STRATS: STRATS, STRAT_LABEL: STRAT_LABEL, SEVERITIES: SEVERITIES, SEV_LABEL: SEV_LABEL, TYPES: TYPES, TYPE_LABEL: TYPE_LABEL, BASIS: BASIS, METRICS: METRICS, PHASE_STATES: PH_STATES,
    // data
    setMission: setMission, getBundle: getBundle, build: build, subscribe: subscribe, refresh: function () { notify(true); },
    normalize: { strategies: normalizeStrategies, setup: setupFrom, classifyType: classifyType, eventsFromSim: eventsFromSim, eventsFromUiRun: eventsFromUiRun, phasesFromSim: phasesFromSim, phasesFromRoute: phasesFromRoute, routeFromEngine: routeFromEngine },
    detect: { enginePlan: isEnginePlan, uiPlan: isUiPlan, uiRun: isUiRun, results: isResults, report: isReport },
    // helpers shared by the views
    util: { isNum: isNum, isObj: isObj, arr: arr, cap: cap, words: words, num: num, round: round, clone: clone, slug: slug, first: first, lonlat: lonlat, metricMap: metricMap,
      fmt: { dur: fmtDur, clock: fmtClock, dist: fmtDist, wh: fmtWh, money: fmtMoney, pct: fmtPct, pctRaw: fmtPctRaw, idx: fmtIdx },
      dom: { h: h, clear: clear, basisChip: basisChip, legend: legend, empty: empty, fixtureBanner: fixtureBanner, download: download, csvCell: csvCell, resolveHost: resolveHost, frame: frame },
      basisOf: basisOf }
  };
  return api;
});
