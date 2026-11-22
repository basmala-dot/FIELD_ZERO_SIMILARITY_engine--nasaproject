/*! FIELD//ZERO mission UI v1.0.0
 *  The frontend interaction layer for planning, rehearsing and reporting a mission.
 *
 *  WHAT THIS FILE DOES
 *    Connects the mission shell (FZShell, inline in index.html) to the mission engines through the contract-1.0 adapter
 *    window.FieldZeroIntegration.api (js/mission-integration.js: planner + simulation + failure + cost + results)
 *    and renders what it returns into the existing chapters. NOTE: window.FieldZeroMission is the planner's own
 *    namespace (create/fromFZ) and is NOT contract 1.0; this file never calls it directly.
 *
 *  WHAT THIS FILE NEVER DOES
 *    - It never plans routes, simulates, scores risk, estimates cost or analyses failures. Those belong to the engine.
 *    - It never invents numbers. A missing value renders as an em dash. Malformed engine output is rejected, not patched.
 *    - It never mixes development-fixture results with real ones (provenance.fixture must agree across a session).
 *    - It never changes app.js, map.js, charts.js, data-loader.js, similarity-engine.js or mission-intelligence.js.
 *
 *  ALREADY OWNED ELSEWHERE (not duplicated here)
 *    Six-step builder, selection cards, validation, Previous/Next, mission summary  -> FZShell (inline in index.html)
 *    Analog explorer map, filters, candidate table, portfolio, evidence             -> app.js / map.js / charts.js
 *  This file only bridges them: it adds a "Use as mission site" action to the explorer and candidate panels.
 *
 *  LOAD ORDER
 *    Any position after js/mission-integration.js and before the end of <body>. It starts on DOMContentLoaded, which
 *    fires after the inline shell script has defined FZShell. The engine is looked up lazily, at launch time.
 *
 *  PUBLIC SURFACE
 *    window.FZMissionUI = { version, contract, init(), getState(), exportResult(), selectRun(id), clear(),
 *                           rehearsal: { play(), pause(), reset(), seek(seconds) } }
 *    window.FZ.mission  = shared mission state (see newMission()). Mutated only by this file.
 *
 *  Typographic note: user-facing text uses real apostrophes and quotation marks.
 */
(function (root) {
  'use strict';
  if (root.FZMissionUI) return;                       // never attach listeners twice

  var doc = root.document;
  var UI_VERSION = '1.0.0', CONTRACT = '1.0';
  var STRATS = ['fast', 'safe', 'scientific'];
  var STRAT_NAME = { fast: 'Fast', safe: 'Safe', scientific: 'Scientific' };
  var OUTCOME_NAME = { success: 'Success', partial: 'Partial success', failed: 'Failed', aborted: 'Aborted' };
  var OUTCOME_RANK = { success: 3, partial: 2, failed: 1, aborted: 0 };
  var SEVERITIES = ['info', 'warning', 'critical'];
  var SEV_COLOR = { info: '#4A6FA5', warning: '#E0894F', critical: '#9C4D34' };
  var NA = '—';
  var REAL_SECONDS = 60;                              // at 1x the whole rehearsal plays in about 60 s
  var LOG_CAP = 200;
  var ENGINE_METHODS = ['catalog', 'validate', 'plan', 'run', 'runScenario'];
  var PATH_ID = { name: 'mb-name', 'objective.text': 'mb-objective', destination: 'mb-body-earth', site: 'mb-site-pick', 'site.lon_deg': 'mb-lon', 'site.lat_deg': 'mb-lat',
    'vehicle.name': 'mb-v-name', 'vehicle.mass_kg': 'mb-v-mass', 'vehicle.max_slope_deg': 'mb-v-slope', 'vehicle.speed_mps_flat': 'mb-v-speed', 'vehicle.power_w': 'mb-v-power', 'vehicle.battery_wh': 'mb-v-battery',
    'constraints.max_cost': 'mb-budget', 'constraints.currency': 'mb-currency', 'constraints.max_duration_s': 'mb-duration', 'constraints.min_battery_pct': 'mb-reserve', seed: 'mb-seed' };
  var DOS_ROWS = ['Route and timeline', 'Rehearsal outcome', 'Failures and recovery', 'Cost and resources', 'Limitations'];

  // ================================================================ small helpers
  function $(id) { return doc.getElementById(id); }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function setText(el, t) { if (el) el.textContent = t; }
  function clear(el) { if (el) while (el.firstChild) el.removeChild(el.firstChild); }
  function h(tag, attrs, kids) {
    var e = doc.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k]; if (v == null || v === false) return;
      if (k === 'text') e.textContent = v; else if (k === 'class') e.className = v; else if (k === 'style') e.style.cssText = v; else e.setAttribute(k, v === true ? '' : String(v));
    });
    (kids || []).forEach(function (c) { if (c == null) return; e.appendChild(typeof c === 'string' ? doc.createTextNode(c) : c); });
    return e;
  }
  function cap(s) { s = String(s == null ? '' : s); return s.charAt(0).toUpperCase() + s.slice(1); }
  function reducedMotion() { return !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches); }
  function num(v, d) { return isNum(v) ? v.toLocaleString('en-US', { maximumFractionDigits: d == null ? 1 : d }) : NA; }
  function fmtDur(s) {
    if (!isNum(s)) return NA; s = Math.round(s); if (s < 60) return s + ' s';
    var m = Math.floor(s / 60), sec = s % 60; if (m < 60) return m + ' min' + (sec ? ' ' + sec + ' s' : '');
    var hr = Math.floor(m / 60); m = m % 60; return hr + ' h' + (m ? ' ' + m + ' min' : '');
  }
  function fmtClock(s) {
    if (!isNum(s)) return NA; s = Math.max(0, Math.round(s)); var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return 'T+' + p(Math.floor(s / 3600)) + ':' + p(Math.floor(s / 60) % 60) + ':' + p(s % 60);
  }
  function fmtDist(m) { return !isNum(m) ? NA : (m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(2) + ' km'); }
  function fmtWh(v) { return isNum(v) ? num(v, 1) + ' Wh' : NA; }
  function fmtMoney(v, cur) { return isNum(v) ? num(v, 2) + (cur ? ' ' + cur : '') : NA; }
  function fmtPct(f, d) { return isNum(f) ? (f * 100).toFixed(d == null ? 0 : d) + ' %' : NA; }
  function fmtPctRaw(p, d) { return isNum(p) ? p.toFixed(d == null ? 1 : d) + ' %' : NA; }
  function fmtRisk(r) { return r && r.level ? cap(r.level) + (isNum(r.score) ? ' (' + r.score.toFixed(2) + ')' : '') : NA; }
  function signed(v, fn) { if (!isNum(v)) return NA; if (v === 0) return 'No change'; return (v > 0 ? '+' : '−') + fn(Math.abs(v)); }
  function yesNo(v) { return v === true ? 'Yes' : v === false ? 'No' : 'Not assessed'; }
  function slug(s) { return String(s).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'x'; }

  // ================================================================ shell wrappers (FZShell is optional at runtime)
  function shell() { return root.FZShell || null; }
  function status(stage, state) { var s = shell(); if (s && s.setStatus) s.setStatus(stage, state); }
  function slog(msg) { var s = shell(); if (s && s.log) s.log(msg); }
  function ready(section, on) { var s = shell(); if (s && s.setReady) s.setReady(section, on); }
  function setOpts(id, opts, ph) { var s = shell(); if (s && s.setOptions) s.setOptions(id, opts, ph); }

  // ================================================================ shared mission state
  function FZ() { return root.FZ || (root.FZ = {}); }
  function newMission() {
    return {
      contract: CONTRACT, ui_version: UI_VERSION, status: 'idle',          // idle | planning | ready | running | error
      engine: { version: null, catalog: null },
      draft: null,                                                           // latest builder values (fz:setup-change)
      setup: null, setupKey: null, plan: null, strategy: null,               // the setup the plan was made for
      runs: {}, nominal_run_id: null, active_run_id: null, scenarios: [],    // scenarios: [{id, name, run_id, baseline_run_id, scenario}]
      fixture: null,                                                         // true | false | null (unknown until the first result)
      playback: { t_s: 0, speed: 1, playing: false, layers: { route: true, waypoints: true, hazards: true, rover: true } },
      error: null
    };
  }
  function M() { var f = FZ(); if (!f.mission) f.mission = newMission(); return f.mission; }
  var S = { inited: false, op: 0, abort: null, planning: false, scnSeq: 0, ui: { failure: null, candSel: null } };

  // ================================================================ engine access and operation control
  function engine() {
    var E = null;
    try { E = root.FieldZeroIntegration ? root.FieldZeroIntegration.api : null; } catch (e) { return { ok: false, reason: 'The mission integration layer failed to start: ' + errText(e) }; }
    if (!E) return { ok: false, reason: 'The mission integration layer is not loaded (expected window.FieldZeroIntegration from js/mission-integration.js).' };
    var miss = ENGINE_METHODS.filter(function (k) { return typeof E[k] !== 'function'; });
    if (miss.length) return { ok: false, reason: 'The mission engine does not provide: ' + miss.join(', ') + '.' };
    if (String(E.contract).split('.')[0] !== CONTRACT.split('.')[0]) return { ok: false, reason: 'The mission engine speaks contract ' + E.contract + ', but this page needs ' + CONTRACT.split('.')[0] + '.x.' };
    return { ok: true, api: E };
  }
  function dataReady() { var f = FZ(); return !!(f.rows && f.analysis); }
  function ctx() { var f = FZ(); return { rows: f.rows, analysis: f.analysis, data: f.data }; }
  function begin() {
    if (S.abort) { try { S.abort.abort(); } catch (e) { /* already settled */ } }
    S.abort = typeof root.AbortController === 'function' ? new root.AbortController() : null;
    return { id: ++S.op, signal: S.abort ? S.abort.signal : undefined };
  }
  function current(o) { return o.id === S.op; }
  function cancelAll() { S.op++; if (S.abort) { try { S.abort.abort(); } catch (e) { /* ignore */ } S.abort = null; } S.planning = false; }
  function isCancel(e) { return !!e && (e.code === 'CANCELLED' || e.name === 'AbortError'); }
  function errText(e) { var m = (e && e.message) || String(e); return e && e.code && m.indexOf(e.code) < 0 ? m + ' (' + e.code + ')' : m; }
  function busy(el, on) { if (!el) return; if (on) el.setAttribute('aria-busy', 'true'); else el.removeAttribute('aria-busy'); }

  // ================================================================ engine output validation (reject, never repair)
  function fail(path, msg) { var e = new Error('The engine returned data this page cannot use (' + path + ': ' + msg + ').'); e.code = 'BAD_ENGINE_OUTPUT'; throw e; }
  function need(cond, path, msg) { if (!cond) fail(path, msg); }
  function validateSummary(s, p) {
    need(s && typeof s === 'object', p, 'missing');
    ['duration_s', 'distance_m', 'energy_used_wh', 'open_failures'].forEach(function (k) { need(isNum(s[k]), p + '.' + k, 'must be a finite number'); });
    need(s.risk && typeof s.risk === 'object', p + '.risk', 'missing');
  }
  function validatePlan(p) {
    need(p && typeof p === 'object', 'plan', 'not an object');
    need(p.strategies && typeof p.strategies === 'object', 'plan.strategies', 'missing');
    need(p.provenance && typeof p.provenance.fixture === 'boolean', 'plan.provenance.fixture', 'must be true or false');
    STRATS.forEach(function (k) {
      var s = p.strategies[k]; need(s && typeof s === 'object', 'plan.strategies.' + k, 'missing');
      need(typeof s.feasible === 'boolean', 'plan.strategies.' + k + '.feasible', 'must be true or false');
      if (s.feasible) { validateSummary(s.summary, 'plan.strategies.' + k + '.summary'); need(s.route && Array.isArray(s.route.waypoints) && Array.isArray(s.route.legs), 'plan.strategies.' + k + '.route', 'needs waypoints and legs'); }
    });
  }
  function validateRun(r, where) {
    need(r && typeof r === 'object', where, 'not an object');
    need(typeof r.run_id === 'string' && r.run_id, where + '.run_id', 'missing');
    need(r.kind === 'nominal' || r.kind === 'scenario', where + '.kind', 'must be nominal or scenario');
    need(OUTCOME_NAME[r.outcome], where + '.outcome', 'must be success, partial, failed or aborted');
    validateSummary(r.summary, where + '.summary');
    need(r.provenance && typeof r.provenance.fixture === 'boolean', where + '.provenance.fixture', 'must be true or false');
    need(r.route && Array.isArray(r.route.waypoints) && Array.isArray(r.route.legs), where + '.route', 'needs waypoints and legs');
    need(r.map && (r.map.crs === 'WGS84' || r.map.crs === 'local_m'), where + '.map.crs', 'must be WGS84 or local_m');
    need(r.timeline && Array.isArray(r.timeline.samples) && r.timeline.samples.length > 0, where + '.timeline.samples', 'needs at least one sample');
    var prev = -Infinity;
    r.timeline.samples.forEach(function (s, i) {
      var p = where + '.timeline.samples[' + i + ']';
      (r.map.crs === 'WGS84' ? ['t_s', 'lon_deg', 'lat_deg'] : ['t_s', 'x_m', 'y_m']).forEach(function (k) { need(isNum(s[k]), p + '.' + k, 'must be a finite number'); });
      need(s.t_s >= prev, p + '.t_s', 'must not go backwards'); prev = s.t_s;
    });
    need(Array.isArray(r.events), where + '.events', 'must be an array');
    r.events.forEach(function (e, i) { need(e && isNum(e.t_s) && e.title != null, where + '.events[' + i + ']', 't_s and title are required'); });
    need(Array.isArray(r.failures), where + '.failures', 'must be an array');
    r.failures.forEach(function (f, i) {
      var p = where + '.failures[' + i + ']';
      need(f && typeof f.id === 'string' && isNum(f.t_s), p, 'id and t_s are required');
      need(SEVERITIES.indexOf(f.severity) >= 0, p + '.severity', 'must be info, warning or critical');
      need(f.recovery && typeof f.recovery === 'object', p + '.recovery', 'missing');
    });
    need(r.cost && typeof r.cost === 'object', where + '.cost', 'missing');
    need(r.resources && Array.isArray(r.resources.t_s) && Array.isArray(r.resources.series), where + '.resources', 'needs t_s and series');
  }
  function fixtureGate(flag, where) {
    var m = M();
    if (m.fixture === null) { m.fixture = flag; return; }
    if (m.fixture !== flag) fail(where, 'mixes development-fixture results with real results; they are never combined');
  }

  // ================================================================ notices (strategy chapter banner)
  function notice(kind, text) {
    var box = $('st-alert'); if (!box) return;
    if (!kind) { box.hidden = true; clear(box); return; }
    clear(box); box.setAttribute('data-kind', kind); box.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    box.appendChild(h('span', { text: text })); box.hidden = false;
  }
  function wiStatus(text, kind) { var e = $('wi-status'); if (!e) return; e.textContent = text || ''; e.setAttribute('role', kind === 'error' ? 'alert' : 'status'); }
  function curOf(plan) { var m = M(); return plan && plan.currency ? plan.currency : (m.setup && m.setup.constraints ? m.setup.constraints.currency : null); }

  // ================================================================ strategy comparison cards
  function setCell(el, text) { if (!el) return; el.textContent = text; el.classList.toggle('fz-na', text === NA); }
  function renderStrategy(plan) {
    var m = M(), cur = curOf(plan);
    STRATS.forEach(function (k) {
      var sp = plan.strategies[k], s = sp.feasible ? sp.summary : null, card = $('st-' + k) ? $('st-' + k).closest('.fz-strat') : null;
      setCell($('st-' + k + '-duration'), s ? fmtDur(s.duration_s) : NA);
      setCell($('st-' + k + '-distance'), s ? fmtDist(s.distance_m) : NA);
      setCell($('st-' + k + '-energy'), s ? fmtWh(s.energy_used_wh) + (isNum(s.energy_margin_pct) ? ' (margin ' + fmtPctRaw(s.energy_margin_pct) + ')' : '') : NA);
      setCell($('st-' + k + '-cost'), s ? fmtMoney(s.cost_expected, cur) : NA);
      setCell($('st-' + k + '-risk'), s && s.risk && s.risk.level ? fmtRisk(s.risk) : NA);
      setCell($('st-' + k + '-success'), s ? (s.outcome_label || NA) : NA);
      var succ = $('st-' + k + '-success'); if (succ) { if (s && s.planner_estimate) succ.setAttribute('title', 'Simulated by the route-simulation engine. Planner estimate: ' + num(s.planner_estimate.total_time_h, 1) + ' h, ' + num(s.planner_estimate.energy_wh, 0) + ' Wh (a different model).'); else succ.removeAttribute('title'); }
      var radio = $('st-' + k); if (radio) radio.disabled = !sp.feasible;
      if (card) {
        var old = card.querySelector('.fz-infeasible'); if (old) old.remove();
        if (sp.feasible) card.removeAttribute('data-status');
        else { card.setAttribute('data-status', 'failed'); card.appendChild(h('p', { class: 'src fz-infeasible', text: 'No feasible route: ' + (sp.infeasible_reason || 'the engine gave no reason.') })); }
      }
    });
    var empty = $('st-empty'); if (empty) empty.hidden = true;
    renderStratTable(plan);
    m.status = 'ready';
  }
  function clearStrategy() {
    STRATS.forEach(function (k) {
      ['duration', 'distance', 'energy', 'cost', 'risk', 'success'].forEach(function (f) { setCell($('st-' + k + '-' + f), NA); var e = $('st-' + k + '-' + f); if (e) e.removeAttribute('title'); });
      var radio = $('st-' + k); if (radio) radio.disabled = false;
      var card = radio ? radio.closest('.fz-strat') : null;
      if (card) { card.removeAttribute('data-status'); var old = card.querySelector('.fz-infeasible'); if (old) old.remove(); }
    });
    var empty = $('st-empty'); if (empty) empty.hidden = false;
    var t = $('cr-strat'); if (t) t.remove();
  }

  // ================================================================ mission control metrics
  function renderMetrics(run) {
    var s = run ? run.summary : null;
    setText($('m-duration'), s ? fmtDur(s.duration_s) : NA);
    setText($('m-cost'), run ? fmtMoney(run.cost.expected, run.cost.currency) : NA);
    setText($('m-energy'), s && isNum(s.energy_margin_pct) ? fmtPctRaw(s.energy_margin_pct) : NA);
    setText($('m-success'), run ? (run.outcome_label || OUTCOME_NAME[run.outcome] || NA) : NA);
    setText($('m-failures'), s ? String(s.open_failures) : NA);
  }

  // ================================================================ virtual rehearsal (map, playback, metrics, log)
  var PB = { run: null, pts: [], evs: [], n: 0, t: 0, tEnd: 0, speed: 1, playing: false, raf: 0, last: null, evIdx: 0, lastT: 0, ended: false,
    map: null, grp: {}, rover: null, trail: null, layers: { route: true, waypoints: true, hazards: true, rover: true } };

  function runLabel(run) {
    if (!run) return NA;
    if (run.kind === 'nominal') return 'Nominal plan (' + (STRAT_NAME[run.strategy] || run.strategy) + ')';
    var sc = M().scenarios.filter(function (x) { return x.run_id === run.run_id; })[0];
    return sc ? sc.name : run.run_id;
  }
  // The map frame follows the run: Earth = WGS84 lon/lat on a street basemap (EPSG:3857); Mars and Moon = local metres
  // (x_m_localTM, y_m_localTM) on L.CRS.Simple with NO basemap. Body lon/lat for Mars and Moon are never drawn on an Earth map.
  function frameOf(run) { return run && run.map && run.map.crs === 'local_m' ? 'local_m' : 'WGS84'; }
  function ensureMap(crs) {
    if (PB.map && PB.crs === crs) return true;
    var el = $('rehearsal-map'); if (!el) return false;
    if (!root.L) { if (!el.getAttribute('data-nolib')) { el.setAttribute('data-nolib', '1'); el.appendChild(h('p', { style: 'padding:20px;color:#ece4d0', text: 'The map library did not load (offline?). Metrics, controls and the event log still work.' })); } return false; }
    try {
      var L = root.L;
      if (PB.map) { try { PB.map.remove(); } catch (e) { /* already gone */ } PB.map = null; PB.rover = null; PB.trail = null; }
      var local = crs === 'local_m';
      PB.map = L.map(el, local ? { crs: L.CRS.Simple, minZoom: -14, maxZoom: 6, zoomSnap: 0.25, zoomDelta: 0.5, attributionControl: false, preferCanvas: true } : { preferCanvas: true, zoomSnap: 0.25, attributionControl: true });
      if (!local) {
        if (PB.map.attributionControl && PB.map.attributionControl.setPrefix) PB.map.attributionControl.setPrefix(false);
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 17, attribution: '© OpenStreetMap contributors' }).addTo(PB.map);
      }
      PB.crs = crs;
      PB.grp.route = L.layerGroup(); PB.grp.waypoints = L.layerGroup(); PB.grp.hazards = L.layerGroup(); PB.grp.rover = L.layerGroup();
      PB.map.setView([0, 0], local ? 0 : 2);
      var note = $('rh-frame'); if (!note) { note = h('p', { class: 'src', id: 'rh-frame' }); var ref = $('rh-run'); if (ref && ref.parentNode) ref.parentNode.insertBefore(note, ref); }
      return true;
    } catch (e) { console.error('Rehearsal map failed:', e); PB.map = null; return false; }
  }
  function groupOn(name, on) {
    if (!PB.map || !PB.grp[name]) return;
    var has = PB.map.hasLayer ? PB.map.hasLayer(PB.grp[name]) : false;
    if (on && !has) PB.grp[name].addTo(PB.map); else if (!on && has) PB.map.removeLayer(PB.grp[name]);
  }
  // one point -> Leaflet [lat, lng] in the frame of the current run
  function ll(p) {
    if (!p) return null;
    if (PB.crs === 'local_m') return isNum(p.x_m) && isNum(p.y_m) ? [p.y_m, p.x_m] : null;
    return isNum(p.lat_deg) && isNum(p.lon_deg) ? [p.lat_deg, p.lon_deg] : null;
  }
  function drawLayers(run) {
    if (!ensureMap(frameOf(run))) return;
    var L = root.L;
    var fr = $('rh-frame'); if (fr) fr.textContent = 'Map frame: ' + (run.map && run.map.frame ? run.map.frame : 'WGS84') + (PB.crs === 'local_m' ? '. No basemap: Mars and Moon positions are never drawn on an Earth map.' : '.');
    ['route', 'waypoints', 'hazards', 'rover'].forEach(function (k) { PB.grp[k].clearLayers(); });
    var all = [], drewLeg = false;
    run.route.legs.forEach(function (leg) {
      var pts = (leg.points || []).map(ll).filter(Boolean); if (pts.length < 2) return;
      drewLeg = true; all = all.concat(pts);
      L.polyline(pts, { color: '#C9A24A', weight: 4, opacity: 0.9 }).bindTooltip('Leg ' + leg.id + ' · ' + fmtDist(leg.distance_m) + ' · ' + fmtDur(leg.duration_s), { sticky: true }).addTo(PB.grp.route);
    });
    if (!drewLeg && PB.pts.length > 1) L.polyline(PB.pts, { color: '#C9A24A', weight: 3, opacity: 0.8, dashArray: '6 6' }).addTo(PB.grp.route);
    PB.trail = L.polyline([], { color: '#5E9C9A', weight: 5, opacity: 0.95 }).addTo(PB.grp.route);
    run.route.waypoints.forEach(function (w) {
      var p = ll(w.point); if (!p) return; all.push(p);
      L.circleMarker(p, { radius: 7, color: '#14213D', weight: 2, fillColor: '#F5F0E6', fillOpacity: 1 }).bindTooltip((w.label || w.id) + (w.kind ? ' · ' + w.kind : '') + (isNum(w.planned_t_s) ? ' · planned ' + fmtClock(w.planned_t_s) : ''), { sticky: true }).addTo(PB.grp.waypoints);
    });
    (run.hazards || []).forEach(function (hz) {
      var p = ll(hz.point); if (!p) return; all.push(p);
      var c = SEV_COLOR[hz.severity] || SEV_COLOR.warning;
      L.circle(p, { radius: isNum(hz.radius_m) ? hz.radius_m : 20, color: c, weight: 2, fillColor: c, fillOpacity: 0.25 }).bindTooltip((hz.label || hz.kind || hz.id) + ' · ' + (hz.severity || '') + (hz.source ? ' · ' + hz.source : ''), { sticky: true }).addTo(PB.grp.hazards);
    });
    PB.rover = L.marker(PB.pts[0] || [0, 0], { keyboard: false, icon: L.divIcon({ className: '', iconSize: [22, 22], html: '<div style="width:18px;height:18px;margin:2px;border-radius:50%;background:#D96F4B;border:3px solid #fff;box-shadow:0 0 0 2px #14213D,0 2px 6px rgba(0,0,0,.5)"></div>' }) });
    PB.rover.addTo(PB.grp.rover);
    ['route', 'waypoints', 'hazards', 'rover'].forEach(function (k) { groupOn(k, PB.layers[k]); });
    all = all.concat(PB.pts);
    try {
      var b = L.latLngBounds(all);
      if (all.length > 1 && b.isValid && b.isValid()) PB.map.fitBounds(b.pad(0.15)); else if (all.length) PB.map.setView(all[0], 14);
    } catch (e) { /* view stays where it was */ }
    root.setTimeout(function () { if (PB.map && PB.map.invalidateSize) PB.map.invalidateSize(); }, 60);
  }
  function lerp(a, b, f) { return isNum(a) && isNum(b) ? a + (b - a) * f : (isNum(a) ? a : (isNum(b) ? b : null)); }
  function sampleAt(t) {
    var s = PB.run.timeline.samples, lo = 0, hi = PB.n - 1;
    if (t >= s[hi].t_s) return { i: hi, a: s[hi], b: s[hi], f: 0 };
    while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (s[mid].t_s <= t) lo = mid; else hi = mid - 1; }
    var a = s[lo], b = s[Math.min(lo + 1, PB.n - 1)], f = b.t_s > a.t_s ? (t - a.t_s) / (b.t_s - a.t_s) : 0;
    return { i: lo, a: a, b: b, f: Math.max(0, Math.min(1, f)) };
  }
  function emptyLog() { var ol = $('rh-log'); if (ol && !$('rh-log-empty')) ol.appendChild(h('li', { class: 'fz-empty', id: 'rh-log-empty', text: 'Events appear here as the rehearsal runs.' })); }
  function addEvent(ev) {
    var ol = $('rh-log'); if (!ol) return; var e = $('rh-log-empty'); if (e) e.remove();
    var li = h('li', { 'data-s': ev.severity || 'info' }, [h('time', { text: fmtClock(ev.t_s) }), h('span', { text: ' ' + ev.title + (ev.detail ? ': ' + ev.detail : '') })]);
    ol.insertBefore(li, ol.firstChild); while (ol.children.length > LOG_CAP) ol.removeChild(ol.lastChild);
  }
  function syncLog(t, rebuild) {
    var ol = $('rh-log'); if (!ol) return;
    if (rebuild || t < PB.lastT) {
      clear(ol); var cnt = 0; while (cnt < PB.evs.length && PB.evs[cnt].t_s <= t) cnt++;
      for (var i = Math.max(0, cnt - LOG_CAP); i < cnt; i++) addEvent(PB.evs[i]);
      PB.evIdx = cnt; if (!cnt) emptyLog();
    } else { while (PB.evIdx < PB.evs.length && PB.evs[PB.evIdx].t_s <= t) addEvent(PB.evs[PB.evIdx++]); }
    PB.lastT = t;
  }
  function setPlayLabel() {
    var b = doc.querySelector('#rehearsal [data-rh="play"]'); if (!b) return;
    b.textContent = !PB.playing && PB.t > 0 && PB.t < PB.tEnd ? 'Resume' : 'Play';
  }
  function liveMode() { var ol = $('rh-log'); if (ol) ol.setAttribute('aria-live', PB.playing && PB.speed >= 4 ? 'off' : 'polite'); }
  function syncPB() { var p = M().playback; p.t_s = PB.t; p.speed = PB.speed; p.playing = PB.playing; p.layers = { route: PB.layers.route, waypoints: PB.layers.waypoints, hazards: PB.layers.hazards, rover: PB.layers.rover }; }
  function render(t, rebuildLog) {
    if (!PB.run) return;
    var p = sampleAt(t), a = p.a, b = p.b, f = p.f;
    var cur = PB.crs === 'local_m' ? [lerp(a.y_m, b.y_m, f), lerp(a.x_m, b.x_m, f)] : [lerp(a.lat_deg, b.lat_deg, f), lerp(a.lon_deg, b.lon_deg, f)];
    if (PB.rover && isNum(cur[0]) && isNum(cur[1])) PB.rover.setLatLng(cur);
    if (PB.trail && isNum(cur[0]) && isNum(cur[1])) PB.trail.setLatLngs(PB.pts.slice(0, p.i + 1).concat([cur]));
    var scrub = $('rh-scrub'); if (scrub) scrub.value = String(p.i);
    setText($('rh-clock'), fmtClock(t));
    var cell = function (id, txt) { var e = $(id); if (!e) return; e.textContent = txt; e.classList.toggle('fz-na', txt === NA); };
    var bat = lerp(a.battery_wh, b.battery_wh, f), cap = M().setup && M().setup.vehicle ? M().setup.vehicle.battery_wh : null;
    cell('rh-m-elapsed', fmtDur(t)); cell('rh-m-distance', fmtDist(lerp(a.distance_m, b.distance_m, f)));
    cell('rh-m-battery', isNum(bat) ? fmtWh(bat) + (isNum(cap) && cap > 0 ? ' (' + (100 * bat / cap).toFixed(0) + ' %)' : '') : NA);
    cell('rh-m-progress', fmtPct(lerp(a.progress, b.progress, f)));
    var st = f >= 1 ? b.status : a.status, se = $('rh-m-status');
    if (se) { se.textContent = st ? cap2(st) : NA; se.classList.toggle('fz-na', !st); if (st) se.setAttribute('data-status', st); else se.removeAttribute('data-status'); }
    syncLog(t, rebuildLog);
    if (t >= PB.tEnd && !PB.ended) { PB.ended = true; status('rehearsal', 'done'); slog('Rehearsal finished: ' + runLabel(PB.run)); }
    setPlayLabel(); syncPB();
  }
  function cap2(s) { return cap(String(s).replace(/_/g, ' ')); }
  function tick(now) {
    if (!PB.playing) return;
    if (PB.last == null) PB.last = now;
    var dt = Math.min(0.25, (now - PB.last) / 1000); PB.last = now;
    var rate = (PB.tEnd > 0 ? PB.tEnd / REAL_SECONDS : 1) * PB.speed, t = PB.t + dt * rate;
    if (t >= PB.tEnd) { PB.t = PB.tEnd; PB.playing = false; render(PB.t); liveMode(); return; }
    PB.t = t; render(t); PB.raf = root.requestAnimationFrame(tick);
  }
  function play() {
    if (!PB.run || PB.playing) return;
    if (PB.t >= PB.tEnd) { PB.t = 0; render(0, true); }
    PB.playing = true; PB.last = null; liveMode(); setPlayLabel(); PB.raf = root.requestAnimationFrame(tick);
  }
  function pause() { if (!PB.playing) return; PB.playing = false; if (PB.raf) root.cancelAnimationFrame(PB.raf); PB.raf = 0; liveMode(); setPlayLabel(); syncPB(); }
  function resetPlayback() { pause(); PB.t = 0; render(0, true); }
  function seek(t, rebuild) { if (!PB.run) return; var wasPlaying = PB.playing; if (wasPlaying) pause(); PB.t = Math.max(0, Math.min(PB.tEnd, t)); render(PB.t, rebuild); if (wasPlaying && PB.t < PB.tEnd) play(); }
  function loadRun(run) {
    pause(); PB.run = run; var smp = run.timeline.samples;
    PB.n = smp.length; PB.tEnd = smp[PB.n - 1].t_s; PB.crs = (PB.map && PB.crs === frameOf(run)) ? PB.crs : PB.crs; var fcrs = frameOf(run); PB.pts = smp.map(function (s) { return fcrs === 'local_m' ? [s.y_m, s.x_m] : [s.lat_deg, s.lon_deg]; });
    PB.evs = run.events.slice().sort(function (x, y) { return x.t_s - y.t_s; }); PB.t = 0; PB.ended = false; PB.evIdx = 0; PB.lastT = 0;
    drawLayers(run);
    var scrub = $('rh-scrub'); if (scrub) { scrub.min = '0'; scrub.max = String(PB.n - 1); scrub.value = '0'; scrub.step = '1'; }
    setText($('rh-run'), 'Rehearsing: ' + runLabel(run));
    render(0, true);
  }
  function clearRehearsal() {
    pause(); PB.run = null; PB.pts = []; PB.evs = []; PB.n = 0; PB.t = 0; PB.tEnd = 0; PB.ended = false; PB.evIdx = 0; PB.lastT = 0;
    if (PB.map) ['route', 'waypoints', 'hazards', 'rover'].forEach(function (k) { if (PB.grp[k]) PB.grp[k].clearLayers(); });
    PB.trail = null; PB.rover = null;
    ['rh-m-elapsed', 'rh-m-distance', 'rh-m-battery', 'rh-m-progress', 'rh-m-status'].forEach(function (id) { var e = $(id); if (e) { e.textContent = NA; e.classList.add('fz-na'); e.removeAttribute('data-status'); } });
    setText($('rh-clock'), NA); setText($('rh-run'), '');
    var scrub = $('rh-scrub'); if (scrub) { scrub.max = '0'; scrub.value = '0'; }
    var ol = $('rh-log'); if (ol) { clear(ol); emptyLog(); }
    setPlayLabel(); syncPB();
  }
  function onRehearsalControl(ev) {
    var d = ev.detail || {}; if (!PB.run) return;
    if (d.action === 'play') play();
    else if (d.action === 'pause') pause();
    else if (d.action === 'reset') resetPlayback();
    else if (d.action === 'speed') { if (isNum(d.speed) && d.speed > 0) { PB.speed = d.speed; liveMode(); syncPB(); } }
    else if (d.action === 'seek') { var s = PB.run.timeline.samples, i = Math.max(0, Math.min(PB.n - 1, Math.round(d.value))); seek(s[i].t_s, true); }
    else if (d.action === 'layer') { if (PB.layers.hasOwnProperty(d.layer)) { PB.layers[d.layer] = !!d.visible; groupOn(d.layer, !!d.visible); syncPB(); } }
  }

  // ================================================================ what-if lab
  function runOfKey(key) { var m = M(); if (key === 'nominal') return m.runs[m.nominal_run_id] || null; var sc = m.scenarios.filter(function (x) { return x.id === key; })[0]; return sc ? m.runs[sc.run_id] : null; }
  function catalogHas(kind, id) { var c = M().engine.catalog; return !!(c && Array.isArray(c[kind]) && c[kind].some(function (x) { return x.id === id; })); }
  function parseScenario(raw) {
    var base = runOfKey(raw.baseline || 'nominal');
    if (!base) return { error: 'Choose a baseline from the list. Pick a strategy first if the list is empty.' };
    var trig = raw.trigger || {}, at = String(trig.at == null ? '' : trig.at).trim(), t;
    if (trig.kind === 'time') {
      var n = Number(at);
      if (at === '' || !isFinite(n) || n < 0) return { error: 'Enter the trigger time in seconds, 0 or more.' };
      if (n > base.timeline.samples[base.timeline.samples.length - 1].t_s) return { error: 'The trigger time is after the end of the baseline (' + fmtClock(base.timeline.samples[base.timeline.samples.length - 1].t_s) + ').' };
      t = { kind: 'time', time_s: n };
    } else if (trig.kind === 'leg' || trig.kind === 'waypoint') {
      var list = trig.kind === 'leg' ? base.route.legs : base.route.waypoints, ids = list.map(function (x) { return String(x.id); });
      if (ids.indexOf(at) < 0) return { error: 'Unknown ' + trig.kind + ' “' + at + '”. Valid ids: ' + ids.slice(0, 10).join(', ') + (ids.length > 10 ? ', …' : '') + '.' };
      t = trig.kind === 'leg' ? { kind: 'leg', leg_id: at } : { kind: 'waypoint', waypoint_id: at };
    } else return { error: 'Choose a trigger type.' };
    if (!raw.injection) return { error: 'Choose an event to inject.' };
    if (!raw.recovery) return { error: 'Choose a recovery policy.' };
    if (raw.probability !== null && raw.probability !== undefined && !(raw.probability >= 0 && raw.probability <= 1)) return { error: 'Probability must be between 0 and 1.' };
    if (raw.seed !== null && raw.seed !== undefined && Math.floor(raw.seed) !== raw.seed) return { error: 'The seed must be a whole number.' };
    if (raw.magnitude !== null && raw.magnitude !== undefined && !isNum(raw.magnitude)) return { error: 'The magnitude must be a number.' };
    var id = 'scn-' + (++S.scnSeq);
    return { base: base, scenario: { id: id, name: raw.name || 'Scenario ' + S.scnSeq, baseline: raw.baseline || 'nominal', trigger: t, injection: raw.injection, recovery: raw.recovery,
      magnitude: raw.magnitude == null ? null : raw.magnitude, probability: raw.probability == null ? null : raw.probability, seed: raw.seed == null ? null : raw.seed } };
  }
  async function startScenario(sc, baseRun) {
    var eng = engine(); if (!eng.ok) { wiStatus(eng.reason, 'error'); return; }
    var o = begin(), btn = $('wi-run'), m = M();
    busy(btn, true); wiStatus('Running “' + sc.name + '”…'); m.status = 'running';
    try {
      var run = await eng.api.runScenario(baseRun, sc, ctx(), { signal: o.signal, onProgress: function (p) { if (current(o) && p && isNum(p.fraction)) wiStatus('Running “' + sc.name + '”… ' + Math.round(p.fraction * 100) + ' %'); } });
      if (!current(o)) return;
      validateRun(run, 'scenario run');
      need(run.kind === 'scenario', 'scenario run.kind', 'must be scenario');
      need(run.scenario_id === sc.id, 'scenario run.scenario_id', 'must echo ' + sc.id);
      need(run.baseline_run_id === baseRun.run_id, 'scenario run.baseline_run_id', 'must echo ' + baseRun.run_id);
      need(!m.runs[run.run_id], 'scenario run.run_id', 'duplicates an existing run');
      fixtureGate(run.provenance.fixture, 'scenario run.provenance.fixture');
      m.runs[run.run_id] = run; m.scenarios.push({ id: sc.id, name: sc.name, run_id: run.run_id, baseline_run_id: baseRun.run_id, scenario: sc });
      m.active_run_id = run.run_id; m.status = 'ready'; m.error = null;
      renderAll(); status('whatif', 'done'); status('failures', 'done'); status('cost', 'done');
      slog('Scenario “' + sc.name + '”: ' + OUTCOME_NAME[run.outcome]); wiStatus('“' + sc.name + '” finished: ' + OUTCOME_NAME[run.outcome] + '.');
    } catch (e) {
      if (!current(o) || isCancel(e)) return;
      m.status = 'ready'; m.error = { code: e.code || 'ERROR', message: errText(e) }; wiStatus('The scenario could not run: ' + errText(e), 'error'); slog('Scenario failed: ' + errText(e));
    } finally { if (current(o)) busy(btn, false); }
  }
  function onWhatIf(ev) {
    var m = M();
    if (!m.nominal_run_id) { wiStatus('Choose a strategy and let the rehearsal load before running a scenario.', 'error'); return; }
    var r = parseScenario(ev.detail || {});
    if (r.error) { wiStatus(r.error, 'error'); return; }
    startScenario(r.scenario, r.base);
  }
  var CMP_ROWS = [
    ['Duration', function (r) { return r.summary.duration_s; }, fmtDur, 'lower'],
    ['Cost', function (r) { return r.cost.expected; }, function (v) { return fmtMoney(v, null); }, 'lower'],
    ['Energy', function (r) { return r.summary.energy_used_wh; }, fmtWh, 'lower'],
    ['Risk index', function (r) { return r.summary.risk ? r.summary.risk.score : null; }, function (v) { return isNum(v) ? v.toFixed(2) : NA; }, 'lower']
  ];
  function cmpRun() { var m = M(), act = m.runs[m.active_run_id]; if (act && act.kind === 'scenario') return act; var last = m.scenarios[m.scenarios.length - 1]; return last ? m.runs[last.run_id] : null; }
  function renderCompare() {
    var body = $('wi-rows'), viz = $('wi-viz'); if (!body) return;
    var run = cmpRun(), base = run ? M().runs[run.baseline_run_id] : null; clear(body); clear(viz);
    var money = function (r, v) { return fmtMoney(v, r.cost.currency); };
    if (!run || !base) {
      ['Duration', 'Cost', 'Energy', 'Risk index', 'Outcome'].forEach(function (n) { body.appendChild(h('tr', null, [h('th', { scope: 'row', text: n }), h('td', { text: NA }), h('td', { text: NA }), h('td', { text: NA })])); });
      return;
    }
    CMP_ROWS.forEach(function (row) {
      var a = row[1](base), b = row[1](run), d = isNum(a) && isNum(b) ? b - a : null, fn = row[0] === 'Cost' ? function (v) { return money(run, v); } : row[2];
      var trend = d === null || d === 0 ? null : ((row[3] === 'lower') === (d < 0) ? 'good' : 'bad');
      var cd = signed(d, fn);
      body.appendChild(h('tr', null, [h('th', { scope: 'row', text: row[0] }), h('td', { text: fn(a) }), h('td', { text: fn(b) }), h('td', { text: cd, 'data-trend': trend })]));
    });
    var ra = OUTCOME_RANK[base.outcome], rb = OUTCOME_RANK[run.outcome];
    body.appendChild(h('tr', null, [h('th', { scope: 'row', text: 'Outcome' }), h('td', { text: OUTCOME_NAME[base.outcome] }), h('td', { text: OUTCOME_NAME[run.outcome] }),
      h('td', { text: base.outcome === run.outcome ? 'No change' : 'Changed', 'data-trend': ra === rb ? null : (rb > ra ? 'good' : 'bad') })]));
    var rx = run.recovery_executed;
    if (rx && rx.executed && rx.outcome) body.appendChild(h('tr', null, [h('th', { scope: 'row', text: 'After recovery (' + policyLabel(run.policy) + ')' }), h('td', { text: NA }), h('td', { text: cap2(rx.outcome.mission_class || rx.outcome.status) + (isNum(rx.outcome.elapsed_s) ? ' · ' + fmtDur(rx.outcome.elapsed_s) : '') }), h('td', { text: 'Simulated continuation', 'data-trend': rx.feasible ? 'good' : 'bad' })]));
    // results visualization: paired bars, each pair scaled to its own larger value (success is on a fixed 0-1 scale)
    viz.appendChild(h('h3', { class: 'fz-sub', text: 'Baseline against “' + runLabel(run) + '”' }));
    CMP_ROWS.forEach(function (row) {
      var a = row[1](base), b = row[1](run); if (!isNum(a) || !isNum(b)) return;
      var scale = row[0] === 'Risk index' ? 1 : Math.max(a, b, 1e-9), fn = row[0] === 'Cost' ? function (v) { return money(run, v); } : row[2];
      var wrap = h('div', { role: 'img', 'aria-label': row[0] + ': baseline ' + fn(a) + ', scenario ' + fn(b), style: 'margin:0 0 12px' }, [h('div', { class: 'src', text: row[0] })]);
      [['Baseline', a, 'var(--navy)'], ['Scenario', b, 'var(--terra)']].forEach(function (x) {
        wrap.appendChild(h('div', { style: 'display:grid;grid-template-columns:76px 1fr 120px;gap:8px;align-items:center;font-size:.85rem' }, [
          h('span', { text: x[0] }),
          h('div', { style: 'height:10px;border-radius:99px;background:var(--parch);overflow:hidden' }, [h('div', { style: 'height:100%;border-radius:99px;width:' + Math.max(1, Math.min(100, 100 * x[1] / scale)).toFixed(1) + '%;background:' + x[2] })]),
          h('span', { text: fn(x[1]) })]));
      });
      viz.appendChild(wrap);
    });
  }
  function renderRunList() {
    var ul = $('wi-list'), m = M(); if (!ul) return; clear(ul);
    var nom = m.runs[m.nominal_run_id];
    if (!nom) { ul.appendChild(h('li', { class: 'fz-empty', text: 'No scenarios yet.' })); return; }
    var item = function (run, text) {
      var on = run.run_id === m.active_run_id;
      return h('li', null, [h('span', { text: text }), h('button', { type: 'button', class: 'fz-mini', 'data-run': run.run_id, 'aria-pressed': on ? 'true' : 'false', 'aria-label': 'Show ' + runLabel(run) + ' in rehearsal, failures and cost', text: on ? 'Showing' : 'View' })]);
    };
    ul.appendChild(item(nom, 'Baseline · ' + runLabel(nom) + ' · ' + OUTCOME_NAME[nom.outcome]));
    m.scenarios.forEach(function (sc) { var r = m.runs[sc.run_id]; ul.appendChild(item(r, sc.name + ' · ' + sc.scenario.injection + ' · ' + OUTCOME_NAME[r.outcome])); });
    if (!m.scenarios.length) ul.appendChild(h('li', { class: 'fz-empty', text: 'No scenarios yet.' }));
  }
  function renderBaselineSelect() {
    var sel = $('wi-baseline'), m = M(); if (!sel) return; var prev = sel.value;
    var opts = [{ value: 'nominal', label: 'Nominal plan' }].concat(m.scenarios.map(function (s) { return { value: s.id, label: s.name }; }));
    setOpts('wi-baseline', opts); sel.value = opts.some(function (o) { return o.value === prev; }) ? prev : 'nominal';
  }
  function renderAtList() {
    var dl = $('wi-at-list'), kind = $('wi-trigger') ? $('wi-trigger').value : 'time', base = runOfKey($('wi-baseline') ? $('wi-baseline').value : 'nominal'); if (!dl) return; clear(dl);
    if (!base || kind === 'time') return;
    (kind === 'leg' ? base.route.legs : base.route.waypoints).forEach(function (x) { dl.appendChild(h('option', { value: String(x.id), label: x.label || String(x.id) })); });
  }
  function renderWhatIf() { renderRunList(); renderBaselineSelect(); renderCompare(); renderAtList(); }
  function clearWhatIf() {
    var m = M(); S.scnSeq = 0;
    var ul = $('wi-list'); if (ul) { clear(ul); ul.appendChild(h('li', { class: 'fz-empty', text: 'No scenarios yet.' })); }
    renderBaselineSelect(); renderCompare(); renderAtList(); wiStatus(''); busy($('wi-run'), false);
    if (m.status === 'running') m.status = 'idle';
  }
  function catalogHint() {
    var c = M().engine.catalog, hint = $('wi-cat-hint'); if (!c || !hint) return;
    var inj = $('wi-injection') ? $('wi-injection').value : '', rec = $('wi-recovery') ? $('wi-recovery').value : '';
    var a = (c.injections || []).filter(function (x) { return x.id === inj; })[0], b = (c.recoveries || []).filter(function (x) { return x.id === rec; })[0], parts = [];
    if (a && a.description) parts.push(a.label + ': ' + a.description); if (b && b.description) parts.push(b.label + ': ' + b.description);
    hint.textContent = parts.length ? parts.join(' ') : 'Event types and recovery policies are listed by the mission engine.';
  }
  function loadCatalog(api) {
    var m = M(), c = null;
    try { c = api.catalog(); } catch (e) { console.error('catalog() failed:', e); }
    var ok = !!(c && Array.isArray(c.injections) && Array.isArray(c.recoveries) && c.injections.length && c.recoveries.length);
    m.engine.version = api.version || null; m.engine.catalog = ok ? c : null;
    if (!ok) { wiStatus('The mission engine returned no event or recovery catalog, so the what-if lab stays locked.', 'error'); return false; }
    setOpts('wi-injection', c.injections.map(function (x) { return { value: x.id, label: x.label || x.id }; }), 'Choose an event');
    setOpts('wi-recovery', c.recoveries.map(function (x) { return { value: x.id, label: x.label || x.id }; }), 'Choose a recovery policy');
    var tr = $('wi-trigger'); if (tr && Array.isArray(c.triggers)) Array.prototype.forEach.call(tr.options, function (o) { o.disabled = c.triggers.indexOf(o.value) < 0; });
    catalogHint(); magnitudeHint(); return true;
  }

  // ================================================================ failure analysis
  function failureById(id) { var m = M(), run = m.runs[m.active_run_id]; return run ? run.failures.filter(function (f) { return f.id === id; })[0] || null : null; }
  function policyLabel(id) { var c = M().engine.catalog, r = c && c.recoveries ? c.recoveries.filter(function (x) { return x.id === id; })[0] : null; return r ? (r.label || r.id) : id; }
  function recoveryText(f) { var r = f.recovery, o = r.outcome ? cap2(r.outcome) : NA; return r.policy ? o + ' · ' + policyLabel(r.policy) : o; }
  function renderFailTimeline(run) {
    var box = $('fa-timeline'); if (!box) return; clear(box);
    var list = run ? run.failures : [];
    if (!run || !list.length) { box.appendChild(h('p', { class: 'src', text: run ? 'No failures to place on the timeline.' : 'The failure timeline appears after a rehearsal or a what-if run.' })); return; }
    var tEnd = run.timeline.samples[run.timeline.samples.length - 1].t_s || 1;
    var track = h('div', { style: 'position:relative;height:44px;margin:4px 8px 4px' }, [h('div', { style: 'position:absolute;left:0;right:0;top:21px;height:2px;background:var(--line-2)' })]);
    list.forEach(function (f) {
      track.appendChild(h('button', { type: 'button', 'data-fid': f.id, 'aria-label': 'Failure at ' + fmtClock(f.t_s) + ': ' + f.component + ', ' + f.severity, title: fmtClock(f.t_s) + ' · ' + f.component + ' · ' + f.severity,
        'aria-pressed': S.ui.failure === f.id ? 'true' : 'false',
        style: 'position:absolute;top:11px;left:' + Math.max(0, Math.min(100, 100 * f.t_s / tEnd)).toFixed(2) + '%;transform:translateX(-50%);width:20px;height:20px;border-radius:50%;padding:0;cursor:pointer;background:' + (SEV_COLOR[f.severity] || '#4A6FA5') +
          ';border:2px solid ' + (S.ui.failure === f.id ? '#F6A93B' : '#fff') + ';box-shadow:0 0 0 1px rgba(24,44,60,.4)' }));
    });
    box.appendChild(h('div', { class: 'src', style: 'display:flex;justify-content:space-between;margin:0 8px 10px' }, [h('span', { text: fmtClock(0) }), h('span', { text: 'Failure timeline' }), h('span', { text: fmtClock(tEnd) })]));
    box.appendChild(track);
    box.insertBefore(track, box.lastChild);       // track above its scale labels
  }
  function renderFailTable(run) {
    var body = $('fa-rows'); if (!body) return; clear(body);
    var sev = $('fa-severity') ? $('fa-severity').value : 'all', list = run ? run.failures.filter(function (f) { return sev === 'all' || f.severity === sev; }) : [];
    if (!list.length) {
      body.appendChild(h('tr', { id: 'fa-empty' }, [h('td', { colspan: '5', text: !run ? 'No failures recorded. They appear after a rehearsal or a what-if run.' : (run.failures.length ? 'No failures at this severity.' : 'No failures were recorded in this run.') })])); return;
    }
    list.forEach(function (f) {
      body.appendChild(h('tr', { 'data-fid': f.id, 'data-s': f.severity, tabindex: '0', 'aria-selected': S.ui.failure === f.id ? 'true' : 'false' }, [
        h('td', { text: fmtClock(f.t_s) }), h('td', { text: f.component || NA }), h('td', { 'data-status': f.severity === 'info' ? null : f.severity, text: cap(f.severity) }),
        h('td', { text: f.root_cause || NA }), h('td', { text: recoveryText(f) })]));
    });
  }
  function renderFailDetail(run) {
    var f = S.ui.failure ? failureById(S.ui.failure) : null, dl = $('fa-dl'), empty = $('fa-detail-empty'), ol = $('fa-recovery'), extra = $('fa-extra');
    if (extra) clear(extra); if (ol) clear(ol);
    if (!f) {
      if (dl) dl.hidden = true; if (empty) empty.hidden = false;
      if (ol) ol.appendChild(h('li', { class: 'fz-empty', text: 'None to show.' })); return;
    }
    if (dl) dl.hidden = false; if (empty) empty.hidden = true;
    var sv = $('fa-sev'); if (sv) { sv.textContent = cap(f.severity); if (f.severity === 'info') sv.removeAttribute('data-status'); else sv.setAttribute('data-status', f.severity); }
    setText($('fa-comp'), f.component || NA); setText($('fa-cause'), f.root_cause || NA); setText($('fa-impact'), f.impact || NA);
    var r = f.recovery;
    if (extra) {
      extra.appendChild(h('p', { class: 'src', text: 'Recovery: ' + recoveryText(f) + (isNum(r.time_cost_s) ? ' · time ' + fmtDur(r.time_cost_s) : '') + (isNum(r.energy_cost_wh) ? ' · energy ' + fmtWh(r.energy_cost_wh) : '') +
        (isNum(r.cost_delta) ? ' · cost ' + signed(r.cost_delta, function (v) { return fmtMoney(v, run.cost.currency); }) : '') + (f.caused_mission_loss ? ' · this failure caused the mission loss' : '') }));
      extra.appendChild(h('button', { type: 'button', class: 'fz-btn ghost', 'data-act': 'replay', 'data-fid': f.id, text: 'Replay in rehearsal' }));
    }
    var opts = Array.isArray(r.options) ? r.options : [];
    if (!opts.length) { ol.appendChild(h('li', { class: 'fz-empty', text: 'The engine reported no recovery options for this failure.' })); return; }
    var retryOk = catalogHas('injections', f.kind), eng = engine().ok;
    opts.forEach(function (o) {
      var can = retryOk && eng && catalogHas('recoveries', o.id) && o.feasible !== false && !!M().nominal_run_id;
      var why = !eng ? 'The mission engine is not available.' : !retryOk ? 'This failure was not injected from the catalog, so it cannot be replayed with another policy.' : !catalogHas('recoveries', o.id) ? 'This option is not a catalog recovery policy.' : o.feasible === false ? 'The engine marks this option as not feasible.' : '';
      ol.appendChild(h('li', { 'data-chosen': o.chosen ? 'true' : null }, [
        h('b', { text: o.label || o.id }), o.chosen ? h('span', { class: 'src', text: ' · Applied' }) : null, o.feasible === false ? h('span', { class: 'src', text: ' · Not feasible' }) : null,
        o.description ? h('span', { class: 'src', style: 'display:block', text: o.description }) : null,
        h('span', { class: 'src', style: 'display:block', text: 'Time ' + fmtDur(o.time_cost_s) + ' · Energy ' + fmtWh(o.energy_cost_wh) + ' · Result ' + (o.outcome ? cap2(o.outcome.mission_class || o.outcome.status) + (isNum(o.outcome.required_total) ? ' (' + o.outcome.required_completed + '/' + o.outcome.required_total + ' required objectives)' : '') : NA) }),
        o.reason_not_chosen ? h('span', { class: 'src', style: 'display:block', text: 'Not chosen: ' + o.reason_not_chosen }) : null,
        h('button', { type: 'button', class: 'fz-mini', 'data-act': 'retry', 'data-fid': f.id, 'data-opt': o.id, disabled: can ? null : true, title: can ? null : why, text: 'Retry with this option' })]));
    });
  }
  function renderFailures(run) {
    var list = run ? run.failures : [];
    if (S.ui.failure && !list.some(function (f) { return f.id === S.ui.failure; })) S.ui.failure = null;
    setText($('fa-count'), run ? String(list.length) : NA);
    setText($('fa-recovered'), run ? String(list.filter(function (f) { return f.recovered === true; }).length) : NA);
    setText($('fa-unrecovered'), run ? String(list.filter(function (f) { return f.recovered === false; }).length) : NA);
    setText($('fa-loss'), run ? (run.loss_cause || 'None') : NA);
    var sel = $('fa-severity'); if (sel) { sel.disabled = !list.length; if (!list.length) sel.value = 'all'; }
    setText($('fa-active'), run ? 'Showing: ' + runLabel(run) : '');
    renderFailTimeline(run); renderFailTable(run); renderFailDetail(run);
  }
  function selectFailure(id) { S.ui.failure = id; var m = M(), run = m.runs[m.active_run_id]; renderFailures(run); }
  function replayFailure(id) {
    var f = failureById(id); if (!f || !PB.run) return;
    var step = PB.run.timeline.dt_s || 1; seek(Math.max(0, f.t_s - 3 * step), true);
    var sec = $('rehearsal'); if (sec && sec.scrollIntoView) sec.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth' });
    if (!reducedMotion()) play(); slog('Replaying failure at ' + fmtClock(f.t_s) + ': ' + (f.component || 'component'));
  }
  function retryFailure(id, optId) {
    var f = failureById(id), m = M(), base = m.runs[m.nominal_run_id]; if (!f || !base) return;
    var o = (f.recovery.options || []).filter(function (x) { return x.id === optId; })[0]; if (!o) return;
    var sc = { id: 'scn-' + (++S.scnSeq), name: 'Retry: ' + (f.component || f.id) + ' → ' + (o.label || o.id), baseline: 'nominal', trigger: { kind: 'time', time_s: f.t_s }, injection: f.kind, recovery: o.id, probability: null, seed: null };
    slog('Retrying the failure at ' + fmtClock(f.t_s) + ' with ' + (o.label || o.id)); startScenario(sc, base);
  }
  function clearFailures() { S.ui.failure = null; renderFailures(null); }

  // ================================================================ cost and resources
  function okSpan(ok, yes, no) { return ok === true ? h('span', { 'data-status': 'success', text: ' ' + yes }) : ok === false ? h('span', { 'data-status': 'warning', text: ' ' + no }) : null; }
  function fillUsed(id, text, extra) { var e = $(id); if (!e) return; clear(e); e.appendChild(doc.createTextNode(text)); if (extra) e.appendChild(extra); e.classList.toggle('fz-na', text === NA && !extra); }
  var PALETTE = ['#E9E4D8', '#B65F43', '#5E9C9A', '#C9A24A', '#4A6FA5'];
  function lineChart(prof) {
    var box = h('div'), groups = {};
    prof.series.forEach(function (s, i) { var u = s.unit || ''; (groups[u] = groups[u] || []).push({ s: s, color: PALETTE[i % PALETTE.length] }); });
    var t = prof.t_s, tMax = t.length ? Math.max.apply(null, t.filter(isNum)) : 0, ns = 'http://www.w3.org/2000/svg';
    Object.keys(groups).forEach(function (unit) {
      var g = groups[unit], vals = [];
      g.forEach(function (x) { x.s.values.forEach(function (v) { if (isNum(v)) vals.push(v); }); });
      (prof.thresholds || []).forEach(function (th) { if ((th.unit || '') === unit && isNum(th.value)) vals.push(th.value); });
      if (!vals.length) { box.appendChild(h('p', { class: 'fz-empty', text: 'No values reported for ' + (unit || 'this series') + '.' })); return; }
      var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals); if (hi === lo) { hi += 1; lo -= 1; }
      var W = 640, H = 220, L = 56, R = 12, T = 12, B = 28, X = function (v) { return L + (tMax > 0 ? v / tMax : 0) * (W - L - R); }, Y = function (v) { return T + (1 - (v - lo) / (hi - lo)) * (H - T - B); };
      var svg = doc.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H); svg.setAttribute('width', '100%'); svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', g.map(function (x) { return x.s.label; }).join(', ') + ' (' + unit + ') over mission time, ' + fmtClock(0) + ' to ' + fmtClock(tMax));
      var add = function (tag, at, text) { var e = doc.createElementNS(ns, tag); Object.keys(at).forEach(function (k) { e.setAttribute(k, at[k]); }); if (text != null) e.textContent = text; svg.appendChild(e); return e; };
      add('line', { x1: L, y1: T, x2: L, y2: H - B, stroke: 'currentColor', 'stroke-opacity': '.4' }); add('line', { x1: L, y1: H - B, x2: W - R, y2: H - B, stroke: 'currentColor', 'stroke-opacity': '.4' });
      add('text', { x: L - 6, y: T + 4, 'text-anchor': 'end', 'font-size': 11, fill: 'currentColor' }, num(hi, 1)); add('text', { x: L - 6, y: H - B, 'text-anchor': 'end', 'font-size': 11, fill: 'currentColor' }, num(lo, 1));
      add('text', { x: L, y: H - 8, 'font-size': 11, fill: 'currentColor' }, fmtClock(0)); add('text', { x: W - R, y: H - 8, 'text-anchor': 'end', 'font-size': 11, fill: 'currentColor' }, fmtClock(tMax));
      add('text', { x: 4, y: H / 2, 'font-size': 11, fill: 'currentColor', transform: 'rotate(-90 10 ' + H / 2 + ')' }, unit);
      (prof.thresholds || []).forEach(function (th) {
        if ((th.unit || '') !== unit || !isNum(th.value)) return;
        add('line', { x1: L, x2: W - R, y1: Y(th.value), y2: Y(th.value), stroke: '#9C4D34', 'stroke-dasharray': '5 4', 'stroke-width': 1.5 }); add('text', { x: W - R - 4, y: Y(th.value) - 4, 'text-anchor': 'end', 'font-size': 11, fill: '#9C4D34' }, th.label);
      });
      g.forEach(function (x) {
        var d = '', pen = false;
        x.s.values.forEach(function (v, i) { if (!isNum(v) || !isNum(t[i])) { pen = false; return; } d += (pen ? 'L' : 'M') + X(t[i]).toFixed(1) + ' ' + Y(v).toFixed(1); pen = true; });
        add('path', { d: d, fill: 'none', stroke: x.color, 'stroke-width': 2 });
      });
      box.appendChild(svg);
      box.appendChild(h('ul', { class: 'fz-key', style: 'display:flex;flex-wrap:wrap;gap:14px;list-style:none;padding:0;margin:6px 0 10px' }, g.map(function (x) { return h('li', null, [h('i', { style: 'display:inline-block;width:12px;height:12px;border-radius:50%;margin-right:6px;background:' + x.color }), x.s.label + ' (' + unit + ')']); })));
      var step = Math.max(1, Math.ceil(t.length / 40)), head = h('tr', null, [h('th', { scope: 'col', text: 'Time' })].concat(g.map(function (x) { return h('th', { scope: 'col', text: x.s.label + ' (' + unit + ')' }); })));
      var rowsEl = []; for (var i = 0; i < t.length; i += step) rowsEl.push(h('tr', null, [h('td', { text: fmtClock(t[i]) })].concat(g.map(function (x) { return h('td', { text: num(x.s.values[i], 1) }); }))));
      box.appendChild(h('details', null, [h('summary', { text: 'Data table' + (step > 1 ? ' (every ' + step + 'th point)' : '') }), h('div', { class: 'fz-tscroll' }, [h('table', null, [h('thead', null, [head]), h('tbody', null, rowsEl)])])]));
    });
    return box;
  }
  function renderStratTable(plan) {
    var old = $('cr-strat'); if (old) old.remove();
    var sec = $('cost'); if (!sec || !plan) return;
    var m = M(), cur = curOf(plan);
    var rows = STRATS.map(function (k) {
      var sp = plan.strategies[k], s = sp.feasible ? sp.summary : null, sel = m.strategy === k;
      var td = function (t) { return h('td', null, [sel ? h('strong', { text: t }) : t]); };
      return h('tr', null, [h('th', { scope: 'row', text: STRAT_NAME[k] + (sel ? ' (selected)' : '') })].concat(s ?
        [td(fmtDur(s.duration_s)), td(fmtDist(s.distance_m)), td(fmtWh(s.energy_used_wh)), td(fmtMoney(s.cost_expected, cur)), td(s.risk && s.risk.level ? fmtRisk(s.risk) : NA), td(s.outcome_label || NA)] :
        [h('td', { colspan: '6', text: 'No feasible route' + (sp.infeasible_reason ? ': ' + sp.infeasible_reason : '') })]));
    });
    sec.appendChild(h('div', { class: 'card', id: 'cr-strat', style: 'margin-top:18px' }, [h('h3', { text: 'Strategy comparison' }),
      h('div', { class: 'fz-tscroll' }, [h('table', null, [h('caption', { class: 'fz-vh', text: 'Planned values for each strategy' }),
        h('thead', null, [h('tr', null, ['Strategy', 'Duration', 'Distance', 'Energy used', 'Cost', 'Risk', 'Outcome'].map(function (x) { return h('th', { scope: 'col', text: x }); }))]), h('tbody', null, rows)])]),
      h('p', { class: 'src', text: 'Values from the simulation of each planned route (route-simulation, cost-engine). The planner own time and energy estimates use a different model and are in the hover text of each outcome.' })]));
  }
  function renderCost(run) {
    var body = $('cr-rows'), prof = $('cr-profile'); if (!body) return; clear(body); clear(prof);
    setText($('cr-active'), run ? 'Showing: ' + runLabel(run) : '');
    if (!run) {
      ['cr-energy-used', 'cr-equip-used', 'cr-dur-used', 'cr-cost-used'].forEach(function (id) { fillUsed(id, NA); });
      body.appendChild(h('tr', { id: 'cr-empty' }, [h('td', { colspan: '4', text: 'No cost estimate yet. It appears after the mission engine plans a route.' })]));
      setText($('cr-assumptions'), ''); prof.appendChild(h('p', { class: 'fz-empty', text: 'The battery and resource curve appears here after a rehearsal.' })); return;
    }
    var c = run.cost, e = c.energy || {}, q = c.equipment || {}, d = c.duration || {};
    fillUsed('cr-energy-used', fmtWh(e.used_wh) + (isNum(e.margin_pct) ? ' · margin ' + fmtPctRaw(e.margin_pct) : ''), okSpan(e.reserve_ok, 'reserve kept', 'below reserve'));
    fillUsed('cr-equip-used', q && Array.isArray(q.used) ? q.used.length + (isNum(q.listed) ? ' of ' + q.listed : '') + (q.used.length ? ': ' + q.used.join(', ') : '') : NA);
    fillUsed('cr-dur-used', fmtDur(d.planned_s), okSpan(d.within_limit, 'within limit', 'over limit'));
    fillUsed('cr-cost-used', isNum(c.expected) ? fmtMoney(c.expected, c.currency) + (isNum(c.estimated) ? ' (pre-run estimate ' + num(c.estimated, 2) + ')' : '') : NA, okSpan(c.within_budget, 'within budget', 'over budget'));
    var money = function (v) { return isNum(v) ? num(v, 2) : NA; };
    if (!Array.isArray(c.breakdown) || !c.breakdown.length) body.appendChild(h('tr', { id: 'cr-empty' }, [h('td', { colspan: '3', text: 'The engine reported no cost breakdown for this run.' })]));
    else {
      c.breakdown.forEach(function (r) { body.appendChild(h('tr', null, [h('th', { scope: 'row', text: r.category + (r.basis ? ' (' + r.basis + ')' : '') }), h('td', { text: money(r.estimated) }), h('td', { text: money(r.simulated) })])); });
      body.appendChild(h('tr', null, [h('th', { scope: 'row', text: 'Total' + (c.currency ? ' (' + c.currency + ')' : '') }), h('td', { text: money(c.estimated) }), h('td', { text: money(c.simulated) })]));
    }
    var notes = (c.assumptions || []).concat(run.environment && run.environment.label ? ['Environment: ' + run.environment.label] : []);
    setText($('cr-assumptions'), (notes.concat(c.budget_note ? [c.budget_note] : [])).join(' ') || 'The engine stated no cost assumptions.');
    prof.appendChild(lineChart(run.resources));
  }

  // ================================================================ mission dossier
  function dlList(rows) { var dl = h('dl', { class: 'fz-dl' }); rows.forEach(function (r) { dl.appendChild(h('dt', { text: r[0] })); dl.appendChild(h('dd', { text: r[1], class: r[1] === NA ? 'fz-na' : null })); }); return dl; }
  function ulList(items, emptyText) { return h('ul', { class: 'plain' }, items.length ? items.map(function (t) { return h('li', { text: t }); }) : [h('li', { class: 'fz-empty', text: emptyText })]); }
  function sec(title, kids) { return h('section', { class: 'fz-dos-sec' }, [h('h3', { class: 'fz-sub', text: title })].concat(kids)); }
  function dossierRowTexts(run) {
    if (!run) return null; var f = run.failures, cur = run.cost.currency, s = run.summary;
    var lim = (run.limitations || []).length + ((M().plan && M().plan.limitations) || []).length;
    return {
      'Route and timeline': run.route.legs.length + ' legs · ' + fmtDist(s.distance_m) + ' · ' + fmtDur(s.duration_s) + ' · ' + run.events.length + ' events',
      'Rehearsal outcome': OUTCOME_NAME[run.outcome] + (run.objective_met === true ? ' · objective met' : run.objective_met === false ? ' · objective not met' : ''),
      'Failures and recovery': f.length + ' failure' + (f.length === 1 ? '' : 's') + ' · ' + f.filter(function (x) { return x.recovered === true; }).length + ' recovered · ' + f.filter(function (x) { return x.recovered === false; }).length + ' not recovered',
      'Cost and resources': fmtMoney(run.cost.expected, cur) + ' · energy margin ' + fmtPctRaw(s.energy_margin_pct),
      'Limitations': lim ? lim + ' stated by the engine' : 'None stated by the engine'
    };
  }
  var patching = false;
  function patchDossierRows() {
    var dl = $('dos-dl'), m = M(), run = m.runs[m.nominal_run_id], t = dossierRowTexts(run); if (!dl || !t || patching) return;
    patching = true;
    try {
      Array.prototype.forEach.call(dl.querySelectorAll('dt'), function (dt) {
        var dd = dt.nextElementSibling, k = dt.textContent;
        if (dd && t[k] && dd.textContent === 'Not generated yet') { dd.textContent = t[k]; dd.classList.remove('fz-na'); }
      });
    } finally { patching = false; }
  }
  function renderDossier() {
    var box = $('dos-result'), m = M(), run = m.runs[m.nominal_run_id]; if (!box) return; clear(box);
    if (!run) { box.appendChild(h('p', { class: 'fz-empty', text: 'No mission results yet. Build a mission, choose a strategy and run the rehearsal to fill this report.' })); patchDossierRows(); return; }
    var plan = m.plan, setup = m.setup, s = run.summary, cur = run.cost.currency;
    if (m.fixture) box.appendChild(h('div', { class: 'fz-alert', 'data-kind': 'warn', role: 'note' }, [h('span', { text: 'Development fixture data. These numbers are not real mission engine results and must not be used as findings.' })]));
    box.appendChild(sec('Mission result', [dlList([
      ['Mission', setup.name || NA], ['Objective', setup.objective && setup.objective.text ? setup.objective.text : NA], ['Strategy', STRAT_NAME[m.strategy] || NA],
      ['Outcome', OUTCOME_NAME[run.outcome] + (run.outcome_reason ? ': ' + run.outcome_reason : '')], ['Objective met', yesNo(run.objective_met)],
      ['Duration', fmtDur(s.duration_s)], ['Distance', fmtDist(s.distance_m)], ['Energy used', fmtWh(s.energy_used_wh)], ['Energy margin', fmtPctRaw(s.energy_margin_pct)],
      ['Risk', s.risk && s.risk.level ? fmtRisk(s.risk) : NA], ['Open failures', String(s.open_failures)]])]));
    var shown = run.events.slice(0, 60);
    box.appendChild(sec('Route and timeline', [
      dlList([['Legs', String(run.route.legs.length)], ['Waypoints', run.route.waypoints.map(function (w) { return (w.label || w.id) + (isNum(w.planned_t_s) ? ' (' + fmtClock(w.planned_t_s) + ')' : ''); }).join(' → ') || NA], ['Hazards', String((run.hazards || []).length)], ['Events', String(run.events.length)]]),
      ulList(shown.map(function (e) { return fmtClock(e.t_s) + ' · ' + cap(e.severity || 'info') + ' · ' + e.title + (e.detail ? ': ' + e.detail : ''); }), 'No events were recorded.'),
      run.events.length > shown.length ? h('p', { class: 'src', text: 'First ' + shown.length + ' of ' + run.events.length + ' events shown. The JSON export has all of them.' }) : null]));
    box.appendChild(sec('Failures and recovery', [ulList(run.failures.map(function (f) {
      return fmtClock(f.t_s) + ' · ' + cap(f.severity) + ' · ' + (f.component || 'component') + ': ' + (f.root_cause || 'no root cause given') + (f.impact ? ' Impact: ' + f.impact + '.' : '') + ' Recovery: ' + recoveryText(f) + '.' + (f.caused_mission_loss ? ' This caused the mission loss.' : '');
    }), 'No failures were recorded in the nominal run.'), run.loss_cause ? h('p', { text: 'Cause of mission loss: ' + run.loss_cause }) : null]));
    var c = run.cost, e = c.energy || {}, d = c.duration || {};
    box.appendChild(sec('Cost and resources', [dlList([
      ['Expected cost', fmtMoney(c.expected, cur) + (isNum(c.low) && isNum(c.high) ? ' (range ' + num(c.low, 2) + ' to ' + num(c.high, 2) + ')' : '')],
      ['Budget limit', setup.constraints && isNum(setup.constraints.max_cost) ? fmtMoney(setup.constraints.max_cost, cur) + (c.within_budget === true ? ' · within budget' : c.within_budget === false ? ' · over budget' : '') : NA],
      ['Battery capacity', fmtWh(e.capacity_wh)], ['Energy used', fmtWh(e.used_wh)], ['Energy margin', isNum(e.margin_wh) ? fmtWh(e.margin_wh) + ' (' + fmtPctRaw(e.margin_pct) + ')' : NA],
      ['Duration against limit', fmtDur(d.planned_s) + (isNum(d.limit_s) ? ' of ' + fmtDur(d.limit_s) : '') + (d.within_limit === false ? ' · over limit' : '')],
      ['Equipment used', c.equipment && Array.isArray(c.equipment.used) ? (c.equipment.used.join(', ') || 'None') + (isNum(c.equipment.listed) ? ' (' + c.equipment.used.length + ' of ' + c.equipment.listed + ')' : '') : NA]]),
      ulList((c.breakdown || []).map(function (r) { return r.category + ': ' + num(r.expected, 2) + ' (' + num(r.low, 2) + ' to ' + num(r.high, 2) + ')'; }), 'No cost breakdown was reported.')]));
    box.appendChild(sec('Scenarios', [ulList(m.scenarios.map(function (sc) {
      var r = m.runs[sc.run_id], b = m.runs[sc.baseline_run_id];
      return sc.name + ' (' + sc.scenario.injection + ', recovery ' + policyLabel(sc.scenario.recovery) + '): ' + OUTCOME_NAME[r.outcome] + ' · duration ' + signed(r.summary.duration_s - b.summary.duration_s, fmtDur) + ' · cost ' + signed(r.cost.expected - b.cost.expected, function (v) { return fmtMoney(v, cur); }) + (r.recovery_executed && r.recovery_executed.executed ? ' · after recovery ' + cap2(r.recovery_executed.outcome.mission_class || r.recovery_executed.outcome.status) : '') + (r.scenario_applied && r.scenario_applied.occurred === false ? ' · event did not occur' : '');
    }), 'No scenarios were run.')]));
    var lim = (run.limitations || []).concat((plan && plan.limitations) || []), ass = (run.assumptions || []).concat((plan && plan.assumptions) || []);
    box.appendChild(sec('Limitations and assumptions', [h('h4', { text: 'Limitations' }), ulList(lim, 'The engine stated no limitations.'), h('h4', { text: 'Assumptions' }), ulList(ass, 'The engine stated no assumptions.'),
      run.environment && run.environment.label ? h('p', { class: 'src', text: 'Environment model: ' + run.environment.label }) : null]));
    box.appendChild(sec('Provenance', [dlList([['Engine version', run.engine_version || (m.engine.version || NA)], ['Contract', CONTRACT], ['Seed used', isNum(run.seed_used) ? String(run.seed_used) : NA], ['Model', run.provenance.model || NA],
      ['Terrain datasets', (run.provenance.terrain || []).join(', ') || NA], ['Result type', run.provenance.fixture ? 'DEVELOPMENT FIXTURE' : 'Engine result'], ['Interface version', UI_VERSION], ['Report generated', new Date().toISOString()]])]));
    patchDossierRows();
  }
  function exportResult() {
    var m = M(), nom = m.runs[m.nominal_run_id]; if (!nom) return null;
    var strategies = {}; STRATS.forEach(function (k) { var sp = m.plan.strategies[k]; strategies[k] = { feasible: sp.feasible, infeasible_reason: sp.infeasible_reason || null, summary: sp.feasible ? sp.summary : null }; });
    return { schema: 'fieldzero.mission-result/1', fixture: !!m.fixture, setup: m.setup,
      plan_summary: { plan_id: m.plan.plan_id || null, engine_version: m.plan.engine_version || null, seed_used: m.plan.seed_used == null ? null : m.plan.seed_used, site_resolved: m.plan.site_resolved || null, environment: m.plan.environment || null, provenance: m.plan.provenance, strategies: strategies },
      selected_strategy: m.strategy, nominal: nom,
      scenario_configs: m.scenarios.map(function (s) { return s.scenario; }), scenarios: m.scenarios.map(function (s) { return m.runs[s.run_id]; }),
      exported_with: { contract: CONTRACT, engine_version: nom.engine_version || m.engine.version || null, ui_version: UI_VERSION } };
  }
  function downloadResult() {
    var out = exportResult(), msg = $('dos-res-status');
    if (!out) { if (msg) { msg.textContent = 'Nothing to download yet. Run a rehearsal first.'; msg.hidden = false; } return; }
    if (msg) msg.hidden = true;
    var a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(out, null, 1)], { type: 'application/json' })), download: out.fixture ? 'fieldzero_mission_result_FIXTURE.json' : 'fieldzero_mission_result.json' });
    doc.body.appendChild(a); a.click(); a.remove(); root.setTimeout(function () { URL.revokeObjectURL(a.href); }, 500); slog('Mission result exported');
  }

  function downloadDossierMd() {
    var msg = $('dos-res-status'), eng = engine(), m = M(), md = null;
    try { md = eng.ok && typeof eng.api.exportMarkdown === 'function' ? eng.api.exportMarkdown(m) : null; } catch (e) { md = null; console.error(e); }
    if (!md) { if (msg) { msg.textContent = 'Nothing to download yet. Run a rehearsal first.'; msg.hidden = false; } return; }
    if (msg) msg.hidden = true;
    var a = h('a', { href: URL.createObjectURL(new Blob([md], { type: 'text/markdown' })), download: 'fieldzero_mission_dossier.md' });
    doc.body.appendChild(a); a.click(); a.remove(); root.setTimeout(function () { URL.revokeObjectURL(a.href); }, 500); slog('Mission dossier exported');
  }
  function magnitudeHint() {
    var c = M().engine.catalog, hint = $('wi-mag-hint'), mag = $('wi-magnitude'), inj = $('wi-injection') ? $('wi-injection').value : '';
    var x = c && c.injections ? c.injections.filter(function (i) { return i.id === inj; })[0] : null;
    if (!hint || !mag) return;
    if (x && x.param) { mag.disabled = false; mag.placeholder = String(x.param.def); hint.textContent = x.param.label + ' (' + x.param.unit + '), allowed ' + x.param.min + ' to ' + x.param.max + '. Blank uses ' + x.param.def + ', an assumed what-if value.'; }
    else { mag.value = ''; mag.disabled = !!x; hint.textContent = x ? 'This event has no magnitude.' : 'Optional. Blank uses the event\'s default (an assumed what-if value).'; }
  }
  // Launch stays locked until the terrain data and similarity analysis exist (fz:data-ready from app.js) and the engine layer is usable.
  function gateLaunch() {
    var btn = $('mb-launch'), box = $('mb-status'); if (!btn) return;
    var eng = engine(), ready = dataReady() && eng.ok;
    btn.disabled = !ready;
    if (!ready && box && !box.textContent) box.textContent = eng.ok ? 'Loading terrain data and the similarity analysis…' : eng.reason;
  }
  function onDataReady() { gateLaunch(); var box = $('mb-status'); if (box && /Loading terrain data/.test(box.textContent)) box.textContent = ''; slog('Terrain data ready; mission planning unlocked'); }
  function onDataFailed(ev) { var box = $('mb-status'), btn = $('mb-launch'); if (btn) btn.disabled = true; if (box) box.textContent = 'The terrain data could not be loaded, so planning is unavailable: ' + ((ev.detail && ev.detail.message) || 'unknown error'); notice('error', 'The terrain data could not be loaded. Planning and rehearsal are unavailable.'); }

  // ================================================================ orchestration
  function renderAll() {
    var m = M(), run = m.runs[m.active_run_id], nom = m.runs[m.nominal_run_id];
    renderMetrics(nom); if (run) loadRun(run); renderWhatIf(); renderFailures(run); renderCost(run); renderDossier();
    if (m.plan) renderStratTable(m.plan);
  }
  function clearRunViews() {
    var m = M(); clearRehearsal(); clearWhatIf(); clearFailures(); renderCost(null); renderMetrics(null);
    m.runs = {}; m.nominal_run_id = null; m.active_run_id = null; m.scenarios = [];
    ready('rehearsal', false); ready('whatif', false); ['rehearsal', 'whatif', 'failures', 'cost'].forEach(function (k) { status(k, 'todo'); });
    renderDossier(); var t = $('cr-strat'); if (t) t.remove(); if (m.plan) renderStratTable(m.plan);
  }
  function resetResults() {
    cancelAll(); var m = M(); clearRunViews(); clearStrategy(); m.plan = null; m.strategy = null; m.setup = null; m.setupKey = null; m.fixture = null; m.status = 'idle'; m.error = null;
    status('strategy', 'todo'); notice(null);
  }
  function setupKey(setup) { var c = {}; Object.keys(setup).forEach(function (k) { if (k !== 'strategy') c[k] = setup[k]; }); return JSON.stringify(c); }
  function checkedStrategy() { var r = doc.querySelector('input[name="strategy"]:checked'); return r ? r.value : null; }
  function showLaunchError(text, field) {
    var box = $('mb-status'); if (box) { clear(box); box.appendChild(doc.createTextNode(text)); }
    slog(text);
  }
  function showValidationErrors(errors) {
    var step = function (p) { return /^(name|objective)/.test(p) ? 1 : /^destination/.test(p) ? 2 : /^site/.test(p) ? 3 : /^(vehicle|equipment)/.test(p) ? 4 : 5; };
    var first = errors[0], btn = doc.querySelector('#mb-steps button[data-goto="' + step(first.path || '') + '"]'); if (btn) btn.click();
    var box = $('mb-err'); if (box) { box.textContent = errors.map(function (e) { return e.message; }).join(' '); box.hidden = false; }
    errors.forEach(function (e) { var el = $(PATH_ID[e.path]); if (el && el.type !== 'radio') el.setAttribute('aria-invalid', 'true'); });
    var f = $(PATH_ID[first.path]); if (f && f.focus) f.focus();
  }
  async function onLaunch(ev) {
    var setup = ev.detail, m = M(); if (!setup) return;
    var eng = engine();
    resetResults(); m.draft = setup;
    if (!eng.ok) { notice('error', eng.reason + ' Planning and rehearsal stay locked until it is available.'); showLaunchError(eng.reason); status('strategy', 'blocked'); m.status = 'error'; m.error = { code: 'NO_ENGINE', message: eng.reason }; return; }
    if (!dataReady()) { var msg = 'The terrain data is still loading. Try again in a moment.'; notice('warn', msg); showLaunchError(msg); return; }
    var v; try { v = eng.api.validate(setup); } catch (e) { v = { ok: false, errors: [{ path: '', code: 'INTERNAL', message: 'The mission engine could not validate the setup: ' + errText(e) }] }; }
    if (!v || v.ok !== true) {
      var errs = v && Array.isArray(v.errors) && v.errors.length ? v.errors : [{ path: '', code: 'INVALID_SETUP', message: 'The mission engine rejected the setup.' }];
      showValidationErrors(errs); showLaunchError('The mission engine found problems with the setup.'); return;
    }
    var o = begin(), launch = $('mb-launch'); S.planning = true; m.status = 'planning'; m.setup = setup; m.setupKey = setupKey(setup);
    busy(launch, true); busy($('strategy'), true); notice('info', 'Planning the three strategies…'); showLaunchError('Planning…'); status('strategy', 'active');
    try {
      loadCatalogSafe(eng.api);
      var plan = await eng.api.plan(setup, ctx(), { signal: o.signal, onProgress: function (p) { if (current(o) && p && isNum(p.fraction)) { var t = 'Planning… ' + Math.round(p.fraction * 100) + ' %' + (p.stage ? ' (' + p.stage + ')' : ''); notice('info', t); showLaunchError(t); } } });
      if (!current(o)) return;
      validatePlan(plan); fixtureGate(plan.provenance.fixture, 'plan.provenance.fixture');
      m.plan = plan; renderStrategy(plan); m.error = null;
      notice(m.fixture ? 'warn' : null, 'Development fixture data: these plans are not real mission engine results.');
      var box = $('mb-status'); if (box) { clear(box); box.appendChild(doc.createTextNode('Plan ready. ')); box.appendChild(h('a', { href: '#strategy', text: 'Choose a strategy' })); }
      slog('Mission planned: ' + STRATS.filter(function (k) { return plan.strategies[k].feasible; }).length + ' of 3 strategies feasible');
      var pre = checkedStrategy(); if (pre && plan.strategies[pre] && plan.strategies[pre].feasible) { S.planning = false; busy(launch, false); busy($('strategy'), false); await runNominal(pre); return; }
      status('strategy', 'active');
    } catch (e) {
      if (!current(o) || isCancel(e)) return;
      m.status = 'error'; m.error = { code: e.code || 'ERROR', message: errText(e) }; m.plan = null; m.fixture = null; clearStrategy();
      notice('error', 'Planning failed: ' + errText(e)); showLaunchError('Planning failed: ' + errText(e)); status('strategy', 'blocked');
    } finally { if (current(o)) { S.planning = false; busy(launch, false); busy($('strategy'), false); } }
  }
  function loadCatalogSafe(api) { try { loadCatalog(api); } catch (e) { console.error(e); } }
  async function runNominal(strategy) {
    var m = M(), sp = m.plan && m.plan.strategies[strategy], eng = engine();
    if (!sp || !sp.feasible) { status('strategy', 'blocked'); notice('warn', STRAT_NAME[strategy] + ' has no feasible route' + (sp && sp.infeasible_reason ? ': ' + sp.infeasible_reason : '.')); return; }
    if (!eng.ok) { notice('error', eng.reason); status('strategy', 'blocked'); return; }
    if (m.scenarios.length) slog('Strategy changed: earlier scenarios were cleared because their baseline changed');
    clearRunViews();
    var o = begin(), card = $('st-' + strategy) ? $('st-' + strategy).closest('.fz-strat') : null;
    m.status = 'running'; busy(card, true); busy($('rehearsal'), true); notice(m.fixture ? 'warn' : 'info', m.fixture ? 'Development fixture data: results are not real mission engine results.' : 'Running the ' + STRAT_NAME[strategy] + ' rehearsal…'); status('strategy', 'active');
    try {
      var run = await eng.api.run(m.setup, sp, ctx(), { signal: o.signal, onProgress: function (p) { if (current(o) && p && isNum(p.fraction) && !m.fixture) notice('info', 'Running the ' + STRAT_NAME[strategy] + ' rehearsal… ' + Math.round(p.fraction * 100) + ' %'); } });
      if (!current(o)) return;
      validateRun(run, 'run'); need(run.kind === 'nominal', 'run.kind', 'must be nominal'); need(run.strategy === strategy, 'run.strategy', 'must echo ' + strategy);
      fixtureGate(run.provenance.fixture, 'run.provenance.fixture');
      m.runs[run.run_id] = run; m.nominal_run_id = run.run_id; m.active_run_id = run.run_id; m.strategy = strategy; m.status = 'ready'; m.error = null;
      renderAll(); ready('rehearsal', true); setPlayLabel(); status('strategy', 'done'); status('rehearsal', 'active'); status('failures', 'done'); status('cost', 'done');
      var catOk = !!m.engine.catalog; ready('whatif', catOk); status('whatif', catOk ? 'active' : 'blocked'); if (!catOk) wiStatus('The what-if lab is locked: the engine gave no catalog.', 'error');
      notice(m.fixture ? 'warn' : null, 'Development fixture data: results are not real mission engine results.');
      slog('Strategy selected: ' + STRAT_NAME[strategy] + ' · outcome ' + OUTCOME_NAME[run.outcome]);
    } catch (e) {
      if (!current(o) || isCancel(e)) return;
      m.status = 'error'; m.error = { code: e.code || 'ERROR', message: errText(e) }; clearRunViews(); status('strategy', 'blocked');
      notice('error', 'The rehearsal could not run: ' + errText(e)); slog('Run failed: ' + errText(e));
    } finally { if (current(o)) { busy(card, false); busy($('rehearsal'), false); } }
  }
  function onStrategy(ev) {
    var k = ev.detail && ev.detail.strategy, m = M(); if (STRATS.indexOf(k) < 0) return;
    if (S.planning) { notice('info', 'Planning is still running. Your choice will run when it finishes.'); return; }
    if (!m.plan) { status('strategy', 'blocked'); var msg = 'Launch the mission from the builder first. The mission engine plans the strategies at launch.'; notice('warn', msg); slog(msg); return; }
    if (m.strategy === k && m.nominal_run_id) { status('strategy', 'done'); return; }
    runNominal(k);
  }
  function onSetupChange(ev) {
    var m = M(); m.draft = ev.detail || null;
    if (m.plan && ev.detail && m.setupKey !== setupKey(ev.detail)) {
      resetResults(); notice('info', 'The mission setup changed, so the plan was discarded. Launch again to plan it.'); slog('Setup changed: plan discarded');
      var box = $('mb-status'); if (box) box.textContent = '';
    }
  }
  function selectRun(id) {
    var m = M(); if (!m.runs[id] || m.active_run_id === id) return;
    m.active_run_id = id; renderAll(); status('rehearsal', 'active'); slog('Showing ' + runLabel(m.runs[id]));
  }

  // ================================================================ explorer bridge: "Use as mission site"
  function setVal(id, v) { var e = $(id); if (!e) return; e.value = String(v); e.dispatchEvent(new root.Event('input', { bubbles: true })); e.dispatchEvent(new root.Event('change', { bubbles: true })); }
  function applySite(lon, lat, msgEl) {
    var r = $('mb-src-manual'); if (!r || !shell()) { if (msgEl) msgEl.textContent = 'The mission builder is not available.'; return; }
    r.checked = true; r.dispatchEvent(new root.Event('change', { bubbles: true })); setVal('mb-lon', lon); setVal('mb-lat', lat);
    slog('Analog site set from the explorer: ' + lat.toFixed(4) + '°N, ' + lon.toFixed(4) + '°E');
    if (msgEl) { clear(msgEl); msgEl.appendChild(doc.createTextNode('Set as the mission site. ')); msgEl.appendChild(h('a', { href: '#builder', text: 'Open the mission builder' })); }
  }
  function addSiteButton(host, id, getCoords) {
    if (!host || $(id)) return;
    var msg = h('span', { class: 'src', 'aria-live': 'polite' }), btn = h('button', { type: 'button', class: 'pin', id: id, text: 'Use as mission site' });
    btn.addEventListener('click', function () { var c = getCoords(); if (c) applySite(c.lon, c.lat, msg); });
    host.appendChild(h('p', null, [btn, ' ', msg]));
  }
  function bindExplorer() {
    var det = $('detail');
    if (det && root.MutationObserver) new root.MutationObserver(function () {
      var sel = FZ().sel; if (sel && sel.body === 'earth' && det.querySelector('#pinbtn')) addSiteButton(det, 'fz-usesite', function () { var s = FZ().sel; return s && s.body === 'earth' ? { lon: s.lon, lat: s.lat } : null; });
    }).observe(det, { childList: true });
    var ct = $('candtable'), cd = $('canddetail');
    if (ct) ct.addEventListener('click', function (e) {
      var tr = e.target.closest ? e.target.closest('tr.cl') : null, f = FZ(); if (!tr || !f.analysis) return;
      var list = f.analysis.candidates[f.target][f.scale === 120 ? 'primary' : 'sensitivity'], c = list && list[+tr.dataset.i];
      S.ui.candSel = c && f.scale === 120 ? { lon: c.lon_deg, lat: c.lat_deg } : null;
    });
    if (cd && root.MutationObserver) new root.MutationObserver(function () {
      if (S.ui.candSel && cd.querySelector('#showmap')) addSiteButton(cd, 'fz-usecand', function () { return S.ui.candSel; });
    }).observe(cd, { childList: true });
  }

  // ================================================================ init
  function after(refId, el, where) { var ref = $(refId); if (ref && ref.parentNode) { if (where === 'before') ref.parentNode.insertBefore(el, ref); else ref.parentNode.insertBefore(el, ref.nextSibling); } return !!ref; }
  function buildDom() {
    if (!$('st-alert')) after('st-empty', h('div', { class: 'fz-alert', id: 'st-alert', hidden: true }), 'before');
    if (!$('rh-run')) after('rh-note', h('p', { class: 'src', id: 'rh-run' }), 'before');
    if (!$('rh-rate')) after('rh-note', h('p', { class: 'src', id: 'rh-rate', text: 'Playback: 1× plays the whole rehearsal in about ' + REAL_SECONDS + ' seconds.' }), 'after');
    if (!$('wi-at-list')) { var dl = h('datalist', { id: 'wi-at-list' }), at = $('wi-at'); if (at && at.parentNode) { at.parentNode.appendChild(dl); at.setAttribute('list', 'wi-at-list'); } }
    if (!$('wi-viz')) { var tw = $('wi-compare') ? $('wi-compare').closest('.fz-tscroll') : null; if (tw && tw.parentNode) tw.parentNode.insertBefore(h('div', { id: 'wi-viz', style: 'margin-top:14px' }), tw.nextSibling); }
    if (!$('fa-active')) { var fs = $('fa-summary'); if (fs && fs.parentNode) fs.parentNode.insertBefore(h('p', { class: 'src', id: 'fa-active' }), fs); }
    if (!$('fa-timeline')) { var ft = $('fa-table') ? $('fa-table').closest('.two') : null; if (ft && ft.parentNode) ft.parentNode.insertBefore(h('div', { id: 'fa-timeline', role: 'group', 'aria-label': 'Failure timeline', style: 'margin:0 0 14px' }), ft); }
    if (!$('fa-extra')) after('fa-dl', h('div', { id: 'fa-extra', style: 'margin-top:10px' }), 'after');
    if (!$('cr-active')) { var cg = $('cr-energy-h') ? $('cr-energy-h').closest('.fz-cols') : null; if (cg && cg.parentNode) cg.parentNode.insertBefore(h('p', { class: 'src', id: 'cr-active' }), cg); }
    if (!$('dos-result')) { var rep = $('dos-report'); if (rep) rep.appendChild(h('div', { id: 'dos-result' })); }
    if (!$('dlmd2')) { var bar2 = $('dlsetup') ? $('dlsetup').parentNode : null; if (bar2) bar2.appendChild(h('button', { type: 'button', id: 'dlmd2', text: 'Download mission dossier (.md)' })); }
    if (!$('dlresult')) {
      var bar = $('dlsetup') ? $('dlsetup').parentNode : null;
      if (bar) { bar.appendChild(h('button', { type: 'button', id: 'dlresult', text: 'Download mission result (.json)' })); }
      if ($('dos-status') && !$('dos-res-status')) $('dos-status').parentNode.insertBefore(h('p', { class: 'note fz-noprint', id: 'dos-res-status', role: 'status', hidden: true }), $('dos-status').nextSibling);
    }
  }
  function bindDelegates() {
    var on = function (id, type, fn) { var e = $(id); if (e) e.addEventListener(type, fn); };
    on('wi-list', 'click', function (e) { var b = e.target.closest('button[data-run]'); if (b) selectRun(b.getAttribute('data-run')); });
    on('wi-trigger', 'change', renderAtList); on('wi-baseline', 'change', renderAtList);
    on('wi-injection', 'change', catalogHint); on('wi-recovery', 'change', catalogHint);
    on('fa-severity', 'change', function () { var m = M(); renderFailTable(m.runs[m.active_run_id]); });
    var pick = function (e) { var t = e.target.closest ? e.target.closest('[data-fid]') : null; if (t && !t.hasAttribute('data-act')) selectFailure(t.getAttribute('data-fid')); };
    on('fa-rows', 'click', pick); on('fa-timeline', 'click', pick);
    on('fa-rows', 'keydown', function (e) { if ((e.key === 'Enter' || e.key === ' ') && e.target.hasAttribute && e.target.hasAttribute('data-fid')) { e.preventDefault(); selectFailure(e.target.getAttribute('data-fid')); } });
    var act = function (e) {
      var b = e.target.closest ? e.target.closest('button[data-act]') : null; if (!b || b.disabled) return;
      if (b.getAttribute('data-act') === 'replay') replayFailure(b.getAttribute('data-fid')); else if (b.getAttribute('data-act') === 'retry') retryFailure(b.getAttribute('data-fid'), b.getAttribute('data-opt'));
    };
    on('fa-recovery', 'click', act); on('fa-extra', 'click', act);
    on('dlresult', 'click', downloadResult);
    on('dlmd2', 'click', downloadDossierMd);
    on('wi-injection', 'change', magnitudeHint);
    var dl = $('dos-dl'); if (dl && root.MutationObserver) new root.MutationObserver(patchDossierRows).observe(dl, { childList: true });
  }
  function init() {
    if (S.inited) return; S.inited = true;
    var m = M(); m.status = 'idle';
    buildDom(); bindDelegates(); bindExplorer();
    doc.addEventListener('fz:mission-launch', onLaunch);
    doc.addEventListener('fz:setup-change', onSetupChange);
    doc.addEventListener('fz:strategy-select', onStrategy);
    doc.addEventListener('fz:rehearsal-control', onRehearsalControl);
    doc.addEventListener('fz:whatif-run', onWhatIf);
    doc.addEventListener('fz:data-ready', onDataReady); doc.addEventListener('fz:data-failed', onDataFailed);
    gateLaunch();
    renderDossier(); setPlayLabel();
    var eng = engine();
    if (!eng.ok) { notice('warn', eng.reason + ' Planning, rehearsal and what-if runs are unavailable until it loads.'); m.error = { code: 'NO_ENGINE', message: eng.reason }; }
    else m.engine.version = eng.api.version || null;
    if (!shell()) console.error('FZShell is missing: the mission builder events will not arrive.');
  }

  root.FZMissionUI = {
    version: UI_VERSION, contract: CONTRACT, init: init, getState: M, exportResult: exportResult, selectRun: selectRun,
    clear: function () { resetResults(); },
    rehearsal: { play: play, pause: pause, reset: resetPlayback, seek: function (s) { if (isNum(s)) seek(s, true); } }
  };
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init); else init();
})(window);
