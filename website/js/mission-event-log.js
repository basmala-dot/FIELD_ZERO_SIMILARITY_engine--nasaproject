/*! FIELD//ZERO mission event log (v1.0.0)
 *
 *  A filterable log of simulation events: navigation changes, objectives, resource warnings, terrain hazards,
 *  failures and recovery. Complements (does not replace) the short rehearsal log in mission-ui.js: this one shows the
 *  whole run, filters by type and severity, searches text, follows the replay clock and exports CSV.
 *
 *  DATA (read through mission-extras-core.js, nothing invented)
 *    contract-1.0 run events + failure records (window.FZ.mission), or simulation report / failure analysis / results
 *    passed with FZExtras.setMission(). Timestamps are simulated mission time (T+hh:mm:ss). Events with no timestamp
 *    are listed last and marked "time n/a".
 *
 *  PUBLIC SURFACE   window.FZEventLog
 *    mount(target?, options?)   target element/selector; else #fz-eventlog; else inserts a chapter after #fz-timeline
 *                               or #rehearsal (options.insert = false disables inserting).
 *    setFilter({ types:[], severities:[], q:'' })   programmatic filter
 *    setRange(fromS, toS, label)  /  clearRange()   restrict to a time window (the timeline uses this)
 *    exportCsv()                 download the currently filtered events
 *    unmount()
 *  EVENTS (document)  fz:event-select { event }
 *
 *  Needs: js/mission-extras-core.js first, css/mission-extras.css.
 */
(function (root) {
  'use strict';
  var X = root.FZExtras;
  if (!X) { if (root.console) root.console.error('mission-event-log.js needs js/mission-extras-core.js loaded first.'); return; }
  if (root.FZEventLog) return;

  var U = X.util, D = U.dom, F = U.fmt, h = D.h, NA = X.NA;
  var inst = null;

  function mount(target, opts) {
    opts = opts || {};
    if (inst) return inst;
    var after = root.document && root.document.getElementById('fz-timeline') ? 'fz-timeline' : 'rehearsal';
    var r = D.resolveHost(target, 'fz-eventlog', opts.insert === false ? null : { after: after, title: 'Mission event log', tag: 'Event log', railLabel: 'Mission Event Log' });
    if (!r) return null;
    var host = r.host;
    var S = { bundle: null, types: {}, sevs: {}, q: '', range: null, upTo: false, desc: false, sel: null, sig: '', limit: 150 };
    var body = D.frame(host, host.id || 'fz-eventlog', 'Mission event log', 'What happened, when, and how serious it was. Filter by type or severity, or follow the replay clock.', r.created);
    host.classList.add('fzx-host'); host.setAttribute('data-fzx', 'eventlog'); S.body = body;

    function visible(b) {
      var q = S.q.trim().toLowerCase(), t = b.playback ? b.playback.t_s : null;
      return b.events.filter(function (e) {
        if (Object.keys(S.types).length && !S.types[e.type]) return false;
        if (Object.keys(S.sevs).length && !S.sevs[e.severity]) return false;
        if (q && (e.title + ' ' + (e.detail || '') + ' ' + (e.code || '')).toLowerCase().indexOf(q) < 0) return false;
        if (S.range) { if (!U.isNum(e.t_s) || e.t_s < S.range.from || e.t_s > S.range.to) return false; }
        if (S.upTo && t != null && U.isNum(e.t_s) && e.t_s > t) return false;
        return true;
      });
    }
    function render(b) {
      b = b || X.getBundle(); S.bundle = b;
      var t = b.playback ? Math.round(b.playback.t_s) : 0;
      var sig = [b.events.map(function (e) { return e.id; }).join(','), JSON.stringify(S.types), JSON.stringify(S.sevs), S.q, JSON.stringify(S.range), S.upTo, S.desc, S.sel, S.limit, S.upTo ? t : '', b.event_source].join('|');
      if (sig === S.sig) return; S.sig = sig;
      var keepQ = S.body.querySelector('.fzx-search input'), had = keepQ && root.document.activeElement === keepQ, pos = had ? keepQ.selectionStart : 0;
      paint(b);
      if (had) { var n = S.body.querySelector('.fzx-search input'); if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch (e) { /* ignore */ } } }
    }
    function paint(b) {
      D.clear(S.body);
      if (b.fixture) S.body.appendChild(D.fixtureBanner());
      if (!b.events.length) {
        var planOnly = b.sources.engine_plan && !b.sources.ui_run && !b.sources.report && !b.sources.results;
        S.body.appendChild(D.empty(planOnly ? 'No simulation has run yet, so there are no events.' : 'No events recorded.',
          planOnly ? 'Planned routes have no events. Run the rehearsal or pass a simulation report with FZExtras.setMission().' : 'The current run reported no events.'));
        return;
      }
      var list = visible(b);
      S.body.appendChild(summary(b));
      S.body.appendChild(filters(b, list));
      if (S.range) S.body.appendChild(h('p', { class: 'fzx-rangebar' }, [h('span', { text: 'Showing ' + (S.range.label || 'selected phase') + ': ' + F.clock(S.range.from) + ' → ' + F.clock(S.range.to) + '. ' }), h('button', { type: 'button', class: 'fz-mini', text: 'Clear time range', onclick: clearRange })]));
      var ordered = S.desc ? list.slice().reverse() : list;
      S.body.appendChild(h('p', { class: 'fzx-count-l src', role: 'status', text: 'Showing ' + list.length + ' of ' + b.events.length + ' events. Times are simulated mission time.' }));
      if (!list.length) S.body.appendChild(D.empty('No events match these filters.', 'Clear a filter to see more.'));
      else S.body.appendChild(table(b, ordered.slice(0, S.limit)));
      if (ordered.length > S.limit) S.body.appendChild(h('button', { type: 'button', class: 'fz-btn ghost fzx-btn', text: 'Show ' + Math.min(150, ordered.length - S.limit) + ' more', onclick: function () { S.limit += 150; S.sig = ''; render(S.bundle); } }));
      S.body.appendChild(h('p', { class: 'src fzx-foot', text: 'Event type and severity come from the simulation. Where the source did not name a type, it is inferred from the event code and shown as such. ' + (b.event_source ? 'Source: ' + b.event_source + '.' : '') }));
    }
    function summary(b) {
      var c = { info: 0, warning: 0, critical: 0 }; b.events.forEach(function (e) { c[e.severity]++; });
      var last = b.events.filter(function (e) { return U.isNum(e.t_s); }).slice(-1)[0];
      return h('div', { class: 'stats fzx-stats' }, [
        stat(String(b.events.length), 'Events'), stat(String(c.critical), 'Critical', c.critical ? 'critical' : null), stat(String(c.warning), 'Warnings', c.warning ? 'warning' : null), stat(String(c.info), 'Info'),
        last ? stat(F.clock(last.t_s), 'Last event') : null
      ]);
    }
    function stat(v, l, s) { return h('div', { class: 'stat', 'data-s': s || null }, [h('b', { text: v }), h('span', { text: l })]); }
    function counts(b, key) { var c = {}; b.events.forEach(function (e) { c[e[key]] = (c[e[key]] || 0) + 1; }); return c; }
    function chipGroup(label, items, active, onToggle) {
      var g = h('div', { class: 'fzx-fgroup', role: 'group', 'aria-label': label }, [h('span', { class: 'fzx-bar-l', text: label })]);
      items.forEach(function (it) {
        g.appendChild(h('button', { type: 'button', class: 'fzx-fchip', 'data-k': it.key, 'aria-pressed': active[it.key] ? 'true' : 'false', onclick: function () { onToggle(it.key); } }, [it.label, h('span', { class: 'fzx-n', text: String(it.n) })]));
      });
      return g;
    }
    function filters(b, list) {
      var tc = counts(b, 'type'), sc = counts(b, 'severity');
      var wrap = h('div', { class: 'fzx-filters' });
      wrap.appendChild(chipGroup('Type', X.TYPES.filter(function (k) { return tc[k]; }).map(function (k) { return { key: k, label: X.TYPE_LABEL[k], n: tc[k] }; }), S.types, function (k) { toggle(S.types, k); }));
      wrap.appendChild(chipGroup('Severity', X.SEVERITIES.filter(function (k) { return sc[k]; }).map(function (k) { return { key: k, label: X.SEV_LABEL[k], n: sc[k] }; }), S.sevs, function (k) { toggle(S.sevs, k); }));
      var row = h('div', { class: 'fzx-frow' });
      row.appendChild(h('label', { class: 'fzx-search' }, [h('span', { class: 'fz-vh', text: 'Search events' }), h('input', { type: 'search', placeholder: 'Search events', value: S.q, oninput: function (e) { S.q = e.target.value; S.limit = 150; render(S.bundle); } })]));
      if (b.playback) row.appendChild(h('label', { class: 'fzx-check' }, [h('input', { type: 'checkbox', checked: S.upTo ? true : null, onchange: function (e) { S.upTo = e.target.checked; render(S.bundle); } }), ' Only up to the replay clock (' + F.clock(b.playback.t_s) + ')']));
      row.appendChild(h('button', { type: 'button', class: 'fz-mini', text: S.desc ? 'Newest first' : 'Oldest first', 'aria-label': 'Toggle sort order', onclick: function () { S.desc = !S.desc; render(S.bundle); } }));
      if (Object.keys(S.types).length || Object.keys(S.sevs).length || S.q || S.range) row.appendChild(h('button', { type: 'button', class: 'fz-mini', text: 'Reset filters', onclick: function () { S.types = {}; S.sevs = {}; S.q = ''; S.range = null; render(S.bundle); } }));
      row.appendChild(h('button', { type: 'button', class: 'fz-mini', text: 'Export CSV (' + list.length + ')', onclick: exportCsv }));
      wrap.appendChild(row);
      return wrap;
    }
    function toggle(map, k) { if (map[k]) delete map[k]; else map[k] = true; S.limit = 150; render(S.bundle); }
    function table(b, list) {
      var showSubj = list.some(function (e) { return e.subject; });
      var t = h('table', { class: 'fzx-log' }, [h('thead', null, [h('tr', null, ['Time', 'Severity', 'Type', 'Event'].map(function (x) { return h('th', { scope: 'col', text: x }); }))])]);
      var tb = h('tbody');
      list.forEach(function (e) {
        var sel = S.sel === e.id;
        var tr = h('tr', { class: 'cl', 'data-s': e.severity, 'aria-selected': sel ? 'true' : 'false', tabindex: '0', onclick: function () { pick(e); }, onkeydown: function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pick(e); } } }, [
          h('td', { class: 'fzx-t', text: U.isNum(e.t_s) ? F.clock(e.t_s) : 'time n/a' }),
          h('td', null, [h('span', { class: 'fzx-sev', 'data-s': e.severity, text: X.SEV_LABEL[e.severity] })]),
          h('td', null, [h('span', { class: 'fzx-type', 'data-k': e.type, text: X.TYPE_LABEL[e.type] }), showSubj && e.subject ? h('span', { class: 'src', text: ' · ' + X.TYPE_LABEL[e.subject] }) : null]),
          h('td', { class: 'fzx-ev' }, [h('b', { text: e.title }), e.detail && sel ? h('span', { class: 'fzx-detail-t', text: e.detail }) : (e.detail ? h('span', { class: 'fzx-detail-t fzx-clip', text: e.detail }) : null)])
        ]);
        tb.appendChild(tr);
      });
      t.appendChild(tb);
      return h('div', { class: 'scroll fzx-logwrap', tabindex: '-1' }, [t]);
    }
    function pick(e) {
      S.sel = S.sel === e.id ? null : e.id; S.sig = ''; render(S.bundle);
      try { root.document.dispatchEvent(new root.CustomEvent('fz:event-select', { detail: { event: e } })); } catch (x) { /* ignore */ }
    }
    function setRange(from, to, label) { if (!U.isNum(from) || !U.isNum(to)) return; S.range = { from: Math.min(from, to), to: Math.max(from, to), label: label || null }; S.limit = 150; render(S.bundle || X.getBundle()); }
    function clearRange() { S.range = null; render(S.bundle); }
    function exportCsv() {
      var b = S.bundle || X.getBundle(), list = visible(b);
      var rows = [['time_s', 'time', 'severity', 'type', 'subject', 'code', 'title', 'detail', 'source', 'basis']];
      list.forEach(function (e) { rows.push([U.isNum(e.t_s) ? e.t_s : '', U.isNum(e.t_s) ? F.clock(e.t_s) : '', e.severity, e.type, e.subject || '', e.code || '', e.title, e.detail || '', e.source, e.basis]); });
      D.download('fieldzero-event-log.csv', rows.map(function (r) { return r.map(D.csvCell).join(','); }).join('\n'), 'text/csv');
    }
    function setFilter(f) {
      f = f || {}; S.types = {}; S.sevs = {}; U.arr(f.types).forEach(function (k) { S.types[k] = true; }); U.arr(f.severities).forEach(function (k) { S.sevs[k] = true; }); S.q = f.q || ''; render(S.bundle || X.getBundle());
    }
    var unsub = X.subscribe(function (b) { render(b); });
    render();
    inst = { host: host, render: render, setFilter: setFilter, setRange: setRange, clearRange: clearRange, exportCsv: exportCsv, unmount: function () { unsub(); D.clear(S.body); inst = null; } };
    return inst;
  }

  root.FZEventLog = {
    version: '1.0.0', mount: mount,
    setFilter: function (f) { if (inst) inst.setFilter(f); }, setRange: function (a, b, l) { if (inst) inst.setRange(a, b, l); }, clearRange: function () { if (inst) inst.clearRange(); },
    exportCsv: function () { if (inst) inst.exportCsv(); }, unmount: function () { if (inst) inst.unmount(); }
  };
})(typeof window !== 'undefined' ? window : globalThis);
