/*! FIELD//ZERO mission dossier view (v1.0.0)
 *
 *  A polished, printable mission report. It only organises what the project already holds: configuration,
 *  destination and sites, strategy, route, simulation results, failures and recovery, resources and cost, scenarios,
 *  limitations and provenance. A section with no data says so and names what would fill it. Nothing is estimated here.
 *
 *  Complements the plain "Mission report" in index.html (#brief). It does not touch it. Person 2 may hide the old one.
 *
 *  EXPORT
 *    Print / save as PDF   prints only the dossier (a clone is printed; the rest of the page is hidden by print CSS)
 *    Markdown (.md)        same sections as the screen, with value basis tags
 *    JSON (.json)          the sections as structured data plus the provenance list
 *
 *  PUBLIC SURFACE   window.FZDossierView
 *    mount(target?, options?)  target element/selector; else #fz-dossier; else inserts a chapter after #brief
 *    model(bundle?)            the section model (also used by the exports)
 *    toMarkdown(bundle?) / toJSON(bundle?)  strings
 *    print()  exportMarkdown()  exportJson()  unmount()
 *
 *  Needs: js/mission-extras-core.js first, css/mission-extras.css.
 */
(function (root) {
  'use strict';
  var X = root.FZExtras;
  if (!X) { if (root.console) root.console.error('mission-dossier-view.js needs js/mission-extras-core.js loaded first.'); return; }
  if (root.FZDossierView) return;

  var U = X.util, D = U.dom, F = U.fmt, h = D.h, NA = X.NA, BASIS = X.BASIS;
  var inst = null;

  // ------------------------------------------------------------------ model: sections of blocks
  // block: {t:'kv', rows:[{k,v,b}]} | {t:'table', head:[], rows:[[cell]], note} | {t:'p', text} | {t:'list', items:[]} | {t:'na', text}
  // cell: string or {v, b, tone}
  function kv(rows) { return { t: 'kv', rows: rows.filter(function (r) { return r; }) }; }
  function r(k, v, b, tone) { return { k: k, v: v == null || v === '' ? null : String(v), b: b || null, tone: tone || null }; }
  function sec(id, title, blocks, needs) {
    var empty = !blocks.length;
    return { id: id, title: title, blocks: empty ? [{ t: 'na', text: 'Not available. ' + (needs || '') }] : blocks, available: !empty };
  }

  function model(b) {
    b = b || X.getBundle();
    var S = b.setup, o = b.outcome, out = [];
    var stLabel = { empty: 'No mission', configured: 'Configured', planned: 'Planned, not simulated', running: 'Rehearsal running', paused: 'Rehearsal paused', completed: 'Completed', partial: 'Partial success', failed: 'Failed', halted: 'Stopped by a failure', aborted: 'Aborted' }[b.state] || b.state;

    // 1 overview
    out.push(sec('overview', 'Overview', [kv([
      r('Mission', S.name || null, 'user'), r('Objective', S.objective || b.objective_text || null, 'user'), r('Status', stLabel),
      o ? r('Simulated outcome', o.label + (o.reason ? '. ' + o.reason : ''), 'simulated', o.tone === 'ok' ? 'good' : o.tone === 'bad' ? 'bad' : null) : null,
      b.selected ? r('Strategy', X.STRAT_LABEL[b.selected], 'user') : null,
      b.fixture === true ? r('Data status', 'Development fixture data. Not real engine results.', null, 'bad') : null,
      b.label ? r('Model statement', b.label) : null
    ])], 'Configure a mission and plan it to start the dossier.'));

    // 2 configuration
    var groups = {}, order = []; S.rows.forEach(function (x) { if (!groups[x.group]) { groups[x.group] = []; order.push(x.group); } groups[x.group].push(r(x.label, x.value, x.basis)); });
    out.push(sec('config', 'Mission configuration', order.map(function (g) { return { t: 'kv', title: g, rows: groups[g] }; }), 'No setup was found in window.FZ.mission, the builder, or the plan.'));

    // 3 destination and sites
    var d = [];
    var ctx = [r('Operating body', S.operating_body ? U.cap(S.operating_body) : (S.body ? U.cap(S.body) : null)), r('Analog target', S.target_body ? U.cap(S.target_body) : null, 'user'),
      S.site && U.isNum(S.site.lon) ? r('Entered site', U.lonlat(S.site.lon, S.site.lat) + (S.site.source ? ' (' + S.site.source + ')' : ''), 'user') : null];
    if (ctx.some(function (x) { return x && x.v; })) d.push(kv(ctx));
    if (b.sites.length) d.push({ t: 'table', title: 'Selected sites', head: ['#', 'Position', 'Elevation', 'Similarity', 'Suitability', 'Risk', 'Visited'],
      rows: b.sites.slice(0, 12).map(function (s) { return [String(s.rank), U.lonlat(s.lon, s.lat) || NA, U.isNum(s.elevation_m) ? U.num(s.elevation_m, 0) + ' m' : NA, { v: U.isNum(s.similarity) ? U.num(s.similarity, 1) : NA, b: s.similarity != null ? 'model' : null }, { v: U.isNum(s.suitability) ? U.num(s.suitability, 1) : NA, b: s.suitability != null ? 'heuristic' : null }, { v: U.isNum(s.risk) ? U.num(s.risk, 1) + (s.risk_class ? ' (' + s.risk_class + ')' : '') : NA, b: s.risk != null ? 'heuristic' : null }, s.visited ? 'Yes' : 'No']; }),
      note: 'Similarity compares four DEM-derived terrain metrics only. It is not a confirmed analog.' + (b.sites.length > 12 ? ' First 12 of ' + b.sites.length + ' shown.' : '') });
    out.push(sec('destination', 'Destination and selected sites', d, 'Needs a plan from the planning engine, or a site entered in the builder.'));

    // 4 strategy
    var st = b.strategies, sb = [];
    if (st.available) {
      var cols = X.STRATS.filter(function (k) { return st.items[k].present; });
      var metricRows = X.METRICS.filter(function (m) { return cols.some(function (k) { return st.items[k].metrics[m.id] && st.items[k].feasible !== false; }); });
      sb.push(kv([r('Chosen strategy', b.selected ? X.STRAT_LABEL[b.selected] : null, 'user'), r('Engine recommendation', st.recommended ? X.STRAT_LABEL[st.recommended] : null, 'heuristic'),
        st.recommendation && st.recommendation.rationale ? r('Why', st.recommendation.rationale, 'heuristic') : null]));
      sb.push({ t: 'table', title: 'Strategies compared', head: ['Metric'].concat(cols.map(function (k) { return X.STRAT_LABEL[k] + (st.items[k].feasible === false ? ' (not feasible)' : ''); })),
        rows: metricRows.map(function (m) { return [m.label].concat(cols.map(function (k) { var x = st.items[k].metrics[m.id]; return x && st.items[k].feasible !== false ? { v: fm(m, x.v, st.currency), b: x.basis } : NA; })); }),
        note: 'Metrics the engine did not report are omitted, not estimated.' });
      if (st.tradeoffs.length) sb.push({ t: 'list', title: 'Trade-offs', items: st.tradeoffs });
    }
    out.push(sec('strategy', 'Strategy', sb, 'Run the planner to get FAST, SAFE and SCIENTIFIC results.'));

    // 5 route
    var rb = [];
    if (b.route && b.route.legs.length) {
      var wl = {}; b.route.waypoints.forEach(function (w) { wl[w.id] = w.label; });
      var tot = b.route.legs.reduce(function (a, l) { return { d: a.d + (U.isNum(l.distance_m) ? l.distance_m : 0), t: a.t + (U.isNum(l.duration_s) ? l.duration_s : 0), e: a.e + (U.isNum(l.energy_wh) ? l.energy_wh : 0) }; }, { d: 0, t: 0, e: 0 });
      rb.push(kv([r('Route basis', b.route.planned ? 'Planned route (estimates)' : 'Simulated run route', b.route.basis), r('Legs', String(b.route.legs.length)), r('Total distance', F.dist(tot.d), b.route.basis), tot.t ? r('Total drive time', F.dur(tot.t), b.route.basis) : null, tot.e ? r('Drive energy', F.wh(tot.e), b.route.basis) : null]));
      rb.push({ t: 'table', title: 'Legs', head: ['Leg', 'From → to', 'Distance', 'Drive time', 'Energy', 'Steepest grade', 'Route risk'],
        rows: b.route.legs.map(function (l) { return [l.id, (wl[l.from] || '?') + ' → ' + (wl[l.to] || '?'), F.dist(l.distance_m), U.isNum(l.duration_s) ? F.dur(l.duration_s) : NA, F.wh(l.energy_wh), U.isNum(l.max_grade_deg) ? U.num(l.max_grade_deg, 1) + '°' : NA, U.isNum(l.risk_index) ? { v: U.num(l.risk_index, 1), b: 'heuristic' } : NA]; }) });
    } else if (b.phases.length) {
      rb.push({ t: 'table', title: 'Simulated segments', head: ['Phase', 'Type', 'Duration', 'Distance', 'State'], rows: b.phases.filter(function (p) { return p.kind === 'transit'; }).map(function (p) { return [p.title, 'Drive', U.isNum(p.duration_s) ? F.dur(p.duration_s) : NA, F.dist(p.distance_m), p.state.replace('_', ' ')]; }) });
    }
    out.push(sec('route', 'Route', rb, 'Needs a planned route or a simulation run.'));

    // 6 results
    var sb2 = [];
    if (o) {
      sb2.push(kv([r('Outcome', o.label, o.basis, o.tone === 'ok' ? 'good' : o.tone === 'bad' ? 'bad' : null), o.reason ? r('Reason', o.reason) : null, o.objective_met === true ? r('Required objectives', 'Met') : o.objective_met === false ? r('Required objectives', 'Not all met', null, 'bad') : null,
        U.isNum(o.progress) ? r('Route driven', F.pct(o.progress, 1), 'simulated') : null, U.isNum(o.duration_s) ? r('Mission duration', F.dur(o.duration_s), 'simulated') : null, U.isNum(o.distance_m) ? r('Distance', F.dist(o.distance_m), 'simulated') : null,
        U.isNum(o.energy_used_wh) ? r('Energy used', F.wh(o.energy_used_wh), 'simulated') : null, U.isNum(o.energy_margin_pct) ? r('Energy margin', F.pctRaw(o.energy_margin_pct, 0), 'simulated') : null,
        U.isNum(o.success_probability) ? r('Success chance', F.pct(o.success_probability, 0), 'estimate') : null, o.risk && U.isNum(o.risk.score) ? r('Risk', (o.risk.level ? o.risk.level + ' · ' : '') + U.num(o.risk.score, 1), 'heuristic') : null,
        o.confidence ? r('Confidence', o.confidence + (o.confidence_note ? '. ' + o.confidence_note : '')) : null]));
      if (o.objectives.length) sb2.push({ t: 'table', title: 'Objectives', head: ['Objective', 'Required', 'Status', 'Completed at'], rows: o.objectives.map(function (x) { return [x.label, x.required ? 'Yes' : 'No', U.words(x.status || 'unknown'), U.isNum(x.t_s) ? F.clock(x.t_s) : NA]; }) });
      if (o.criteria.length) sb2.push({ t: 'table', title: 'Success criteria', head: ['Criterion', 'Met'], rows: o.criteria.map(function (c) { return [c.description || c.id, c.met === true ? { v: 'Yes', tone: 'good' } : c.met === false ? { v: 'No', tone: 'bad' } : NA]; }) });
    }
    out.push(sec('results', 'Simulation results', sb2, 'No simulation has run. Run the rehearsal or pass a results object.'));

    // 7 failures
    var fb = [];
    if (b.failures.length) fb.push({ t: 'table', head: ['Time', 'Severity', 'What failed', 'Cause', 'Impact', 'Recovery'],
      rows: b.failures.map(function (f) { return [U.isNum(f.t_s) ? F.clock(f.t_s) : NA, { v: X.SEV_LABEL[f.severity], tone: f.severity === 'critical' ? 'bad' : null }, (f.component || f.code || 'Failure') + (f.caused_loss ? ' (caused the mission loss)' : ''), f.cause || f.message || NA, f.impact || NA, f.recovery || NA]; }),
      note: 'Failures are simulated with an assumed model.' });
    else if (o) fb.push({ t: 'p', text: 'The simulated run recorded no failures.' });
    out.push(sec('failures', 'Failures and recovery', fb, 'No simulation has run.'));

    // 8 resources and cost
    var cb = [], res = b.resources, c = b.cost;
    if (res && res.energy) cb.push(kv([r('Battery capacity (usable)', F.wh(res.energy.capacity_wh), 'simulated'), r('Energy used', F.wh(res.energy.used_wh), 'simulated'), U.isNum(res.energy.lowest_wh) ? r('Lowest battery level', F.wh(res.energy.lowest_wh), 'simulated') : null, U.isNum(res.energy.reserve_wh) ? r('Reserve', F.wh(res.energy.reserve_wh), 'assumption') : null,
      res.time && U.isNum(res.time.elapsed_s) ? r('Elapsed time', F.dur(res.time.elapsed_s) + (U.isNum(res.time.limit_s) ? ' of ' + F.dur(res.time.limit_s) + ' limit' : ''), 'simulated') : null]));
    if (res && res.equipment && res.equipment.length) cb.push({ t: 'table', title: 'Equipment', head: ['Item', 'Used', 'Available', 'Status'], rows: res.equipment.map(function (e) { return [e.name || e.id, U.isNum(e.hours_used) ? U.num(e.hours_used, 1) + ' h' : NA, U.isNum(e.available_hours) ? U.num(e.available_hours, 1) + ' h' : NA, U.words(e.status || '')]; }) });
    if (res && res.consumables && res.consumables.length) cb.push({ t: 'table', title: 'Consumables', head: ['Item', 'Used', 'Available', 'Status'], rows: res.consumables.map(function (e) { return [e.name || e.id, U.num(e.used, 0) + ' ' + (e.unit || ''), U.num(e.available, 0) + ' ' + (e.unit || ''), U.words(e.status || '')]; }) });
    if (c) {
      cb.push(kv([r('Total cost', F.money(c.expected, c.currency), c.basis === 'estimate' ? 'estimate' : 'simulated'), U.isNum(c.low) ? r('Range', F.money(c.low) + ' to ' + F.money(c.high)) : null,
        c.within_budget === true ? r('Budget', 'Within the limit') : c.within_budget === false ? r('Budget', 'Over the limit', null, 'bad') : null, c.rate_basis === 'placeholder' ? r('Rates', 'Placeholder rates, not calibrated to a real programme', 'placeholder') : null]));
      if (c.breakdown.length) cb.push({ t: 'table', title: 'Cost breakdown', head: ['Item', 'Amount'], rows: c.breakdown.map(function (x) { return [x.category + (x.quantity != null && x.unit ? ' (' + U.num(x.quantity, 1) + ' ' + x.unit + ')' : ''), { v: F.money(x.expected), b: x.basis }]; }) });
    }
    out.push(sec('resources', 'Resources and cost', cb, 'Needs simulation results or the cost module output.'));

    // 9 scenarios
    out.push(sec('scenarios', 'What-if scenarios', b.scenarios.length ? [{ t: 'table', head: ['Scenario', 'Outcome', 'Baseline', 'Duration change', 'Cost change'], rows: b.scenarios.map(function (s) {
      return [s.name + (s.injection ? ' (' + s.injection + ')' : ''), s.outcome || NA, s.baseline_outcome || NA, U.isNum(s.d_duration_s) ? (s.d_duration_s >= 0 ? '+' : '−') + F.dur(Math.abs(s.d_duration_s)) : NA, U.isNum(s.d_cost) ? (s.d_cost >= 0 ? '+' : '−') + F.money(Math.abs(s.d_cost)) : NA]; }), note: 'Scenario results are simulated.' }] : [], 'Run a what-if scenario to compare against the baseline.'));

    // 10 limitations
    var lb = [];
    if (b.limitations.length) lb.push({ t: 'list', title: 'Data limitations', items: b.limitations.slice(0, 30).map(function (l) { return (l.severity ? '[' + l.severity + '] ' : '') + l.statement; }) });
    if (b.gaps && b.gaps.items.length) lb.push({ t: 'list', title: 'Evidence gaps' + (b.gaps.counts ? ' (' + Object.keys(b.gaps.counts).map(function (k) { return b.gaps.counts[k] + ' ' + k.toLowerCase(); }).join(', ') + ')' : ''), items: b.gaps.items.map(function (g) { return g.variable + ' (' + g.body + '): ' + g.status + '. Cannot conclude: ' + g.cannot_conclude; }) });
    if (b.assumptions.length) lb.push({ t: 'list', title: 'Assumptions', items: b.assumptions.slice(0, 30) });
    if (b.provenance.length) lb.push(kv(b.provenance.map(function (p) { return r(p[0], p[1]); })));
    if (b.disclaimer) lb.push({ t: 'p', text: b.disclaimer });
    out.push(sec('limits', 'Limitations, assumptions and provenance', lb, 'No limitation lists were supplied.'));
    return out;
  }
  function fm(m, v, cur) {
    return ({ dur: F.dur, dist: F.dist, wh: F.wh, int: function (x) { return String(Math.round(x)); }, pct: function (x) { return F.pctRaw(x, 0); }, frac: function (x) { return F.pct(x, 0); }, money: function (x) { return F.money(x, cur); } }[m.kind] || function (x) { return U.num(x, 1); })(v);
  }

  // ------------------------------------------------------------------ renderers
  function cellEl(c) {
    if (c && typeof c === 'object') return h('td', { 'data-tone': c.tone || null }, [c.v, c.b ? ' ' : null, c.b ? D.basisChip(c.b) : null]);
    return h('td', { text: c == null ? NA : c });
  }
  function blockEl(bl) {
    if (bl.t === 'na') return h('p', { class: 'fzx-na-note', text: bl.text });
    if (bl.t === 'p') return h('p', { text: bl.text });
    if (bl.t === 'list') return h('div', null, [bl.title ? h('h4', { text: bl.title }) : null, h('ul', { class: 'fzx-list' }, bl.items.map(function (i) { return h('li', { text: i }); }))]);
    if (bl.t === 'kv') {
      var dl = h('dl', { class: 'fz-dl fzx-dl' });
      bl.rows.forEach(function (x) { dl.appendChild(h('dt', { text: x.k })); dl.appendChild(h('dd', { class: x.v == null ? 'fz-na' : null, 'data-tone': x.tone }, x.v == null ? [NA] : [x.v, x.b ? ' ' : null, x.b ? D.basisChip(x.b) : null])); });
      return h('div', null, [bl.title ? h('h4', { text: bl.title }) : null, dl]);
    }
    if (bl.t === 'table') {
      var t = h('table', null, [h('thead', null, [h('tr', null, bl.head.map(function (x) { return h('th', { scope: 'col', text: x }); }))]), h('tbody', null, bl.rows.map(function (rw) { return h('tr', null, rw.map(cellEl)); }))]);
      return h('div', null, [bl.title ? h('h4', { text: bl.title }) : null, h('div', { class: 'scroll' }, [t]), bl.note ? h('p', { class: 'src', text: bl.note }) : null]);
    }
    return h('span');
  }
  function article(b, secs) {
    var art = h('article', { class: 'fzx-paper paper', 'aria-label': 'Mission dossier' });
    var S = b.setup, title = S.name || 'Mission dossier';
    art.appendChild(h('header', { class: 'fzx-paper-h' }, [h('p', { class: 'fzx-kick', text: 'FIELD//ZERO · Mission dossier' }), h('h3', { text: title }), h('p', { class: 'src', text: 'Generated ' + new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC · values are simulated or estimated with assumed models, not measured.' })]));
    if (b.fixture) art.appendChild(D.fixtureBanner());
    secs.forEach(function (s, i) {
      var el = h('section', { class: 'fzx-sec', id: 'fzx-d-' + s.id, 'data-available': s.available ? 'true' : 'false' }, [h('h3', { class: 'fzx-sec-h' }, [h('span', { class: 'fzx-sec-n', text: String(i + 1) }), s.title])]);
      s.blocks.forEach(function (bl) { el.appendChild(blockEl(bl)); });
      art.appendChild(el);
    });
    art.appendChild(D.legend(['dataset', 'user', 'model', 'estimate', 'simulated', 'heuristic', 'assumption', 'placeholder']));
    return art;
  }
  function cellText(c) { return c && typeof c === 'object' ? c.v + (c.b ? ' [' + BASIS[c.b] + ']' : '') : (c == null ? NA : String(c)); }
  function mdEsc(s) { return String(s).replace(/\|/g, '\\|').replace(/\n/g, ' '); }
  function toMarkdown(b) {
    b = b || X.getBundle(); var secs = model(b), L = ['# ' + (b.setup.name || 'Mission dossier'), '', '_FIELD//ZERO mission dossier. Values are simulated or estimated with assumed models, not measured. Basis tags in brackets._', ''];
    if (b.fixture) L.push('> Development fixture data. Not real engine results.', '');
    secs.forEach(function (s, i) {
      L.push('## ' + (i + 1) + '. ' + s.title, '');
      s.blocks.forEach(function (bl) {
        if (bl.title) L.push('**' + bl.title + '**', '');
        if (bl.t === 'na' || bl.t === 'p') L.push(bl.text, '');
        else if (bl.t === 'list') { bl.items.forEach(function (x) { L.push('- ' + x); }); L.push(''); }
        else if (bl.t === 'kv') { bl.rows.forEach(function (x) { L.push('- **' + x.k + ':** ' + (x.v == null ? NA : x.v) + (x.b ? ' [' + BASIS[x.b] + ']' : '')); }); L.push(''); }
        else if (bl.t === 'table') { L.push('| ' + bl.head.map(mdEsc).join(' | ') + ' |', '| ' + bl.head.map(function () { return '---'; }).join(' | ') + ' |'); bl.rows.forEach(function (rw) { L.push('| ' + rw.map(function (c) { return mdEsc(cellText(c)); }).join(' | ') + ' |'); }); if (bl.note) L.push('', '_' + bl.note + '_'); L.push(''); }
      });
    });
    return L.join('\n');
  }
  function toJSON(b) {
    b = b || X.getBundle();
    return JSON.stringify({ schema: 'fieldzero-dossier-view-1', generated_utc: new Date().toISOString(), fixture: b.fixture, state: b.state, basis_legend: BASIS,
      sections: model(b).map(function (s) { return { id: s.id, title: s.title, available: s.available, blocks: s.blocks }; }), provenance: b.provenance, sources: b.sources }, null, 2);
  }
  function print() {
    var d = root.document, b = X.getBundle(), prev = d.getElementById('fz-x-print-root'); if (prev) prev.remove();
    var pr = h('div', { id: 'fz-x-print-root', 'aria-hidden': 'true' }, [article(b, model(b))]);
    d.body.appendChild(pr); d.documentElement.classList.add('fzx-printing');
    var done = function () { d.documentElement.classList.remove('fzx-printing'); pr.remove(); root.removeEventListener('afterprint', done); };
    root.addEventListener('afterprint', done); root.setTimeout(function () { try { root.print(); } catch (e) { done(); } }, 60);
  }

  function mount(target, opts) {
    opts = opts || {};
    if (inst) return inst;
    var r0 = D.resolveHost(target, 'fz-dossier', opts.insert === false ? null : { after: 'brief', title: 'Mission dossier', tag: 'Dossier', railLabel: 'Mission Dossier (report view)' });
    if (!r0) return null;
    var host = r0.host, S = { sig: '', b: null };
    var body = D.frame(host, host.id || 'fz-dossier', 'Mission dossier', 'One page that gathers everything the mission produced. Print it or take it as Markdown or JSON.', r0.created);
    host.classList.add('fzx-host'); host.setAttribute('data-fzx', 'dossier'); S.body = body;
    function render(b) {
      b = b || X.getBundle(); S.b = b; var secs = model(b), sig = JSON.stringify(secs) + b.fixture + b.state; if (sig === S.sig) return; S.sig = sig;
      D.clear(S.body);
      var nav = h('nav', { class: 'fzx-dnav', 'aria-label': 'Dossier sections' }, secs.map(function (s, i) { return h('a', { href: '#fzx-d-' + s.id, 'data-available': s.available ? 'true' : 'false', title: s.available ? null : 'No data yet', text: (i + 1) + '. ' + s.title, onclick: function (e) { var t = root.document.getElementById('fzx-d-' + s.id); if (t) { e.preventDefault(); t.scrollIntoView({ behavior: 'smooth', block: 'start' }); } } }); }));
      var tools = h('div', { class: 'fzx-bar fzx-dtools' }, [
        h('button', { type: 'button', class: 'fz-btn', text: 'Print or save as PDF', onclick: print }),
        h('button', { type: 'button', class: 'fz-btn ghost', text: 'Download Markdown', onclick: function () { D.download('fieldzero-dossier.md', toMarkdown(S.b), 'text/markdown'); } }),
        h('button', { type: 'button', class: 'fz-btn ghost', text: 'Download JSON', onclick: function () { D.download('fieldzero-dossier.json', toJSON(S.b), 'application/json'); } })
      ]);
      var got = secs.filter(function (s) { return s.available; }).length;
      S.body.appendChild(h('p', { class: 'src', role: 'status', text: got + ' of ' + secs.length + ' sections have data.' }));
      S.body.appendChild(tools);
      S.body.appendChild(h('div', { class: 'fzx-dgrid' }, [nav, article(b, secs)]));
    }
    var unsub = X.subscribe(function (b, i) { if (i && i.dataChanged) render(b); });
    render();
    inst = { host: host, render: render, unmount: function () { unsub(); D.clear(S.body); inst = null; } };
    return inst;
  }

  root.FZDossierView = { version: '1.0.0', mount: mount, model: model, toMarkdown: toMarkdown, toJSON: toJSON, print: print,
    exportMarkdown: function () { D.download('fieldzero-dossier.md', toMarkdown(), 'text/markdown'); }, exportJson: function () { D.download('fieldzero-dossier.json', toJSON(), 'application/json'); },
    render: function (b) { if (inst) inst.render(b); }, unmount: function () { if (inst) inst.unmount(); } };
})(typeof window !== 'undefined' ? window : globalThis);
