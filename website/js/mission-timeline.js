/*! FIELD//ZERO mission timeline (v1.0.0)
 *
 *  Shows the phases of a mission in sequence (start, each drive leg, work at each site, end) and where the mission
 *  stands: completed, active, pending, failed or not reached. Pure view: it reads the normalised bundle from
 *  mission-extras-core.js and never computes mission results.
 *
 *  WHERE THE PHASES COME FROM (nothing is invented)
 *    - simulation report (FZ-SIM-REPORT-0.1):  real segments, objectives and halt point  -> final outcome per phase
 *    - contract-1.0 run (window.FZ.mission):   route legs and planned waypoint times     -> final outcome, or the live
 *                                              replay position (window.FZ.mission.playback.t_s)
 *    - planning-engine plan (FAST/SAFE/SCIENTIFIC): legs and assumed dwell time           -> "planned" phases (no progress)
 *  If none of these exists the view shows an empty state.
 *
 *  PUBLIC SURFACE   window.FZTimeline
 *    mount(target?, options?)   target: element or selector. Without one, uses #fz-timeline, else inserts a chapter
 *                               after #rehearsal (options.insert = false disables inserting). Returns the instance.
 *    render(bundle?)            re-render now (bundle optional: defaults to FZExtras.getBundle())
 *    selectPhase(id|null)       select a phase and show its detail
 *    unmount()
 *  EVENTS (document)  fz:phase-select  { phase, from_t_s, to_t_s }   (also calls FZEventLog.setRange when it exists)
 *
 *  Needs: js/mission-extras-core.js loaded first, css/mission-extras.css.
 */
(function (root) {
  'use strict';
  var X = root.FZExtras;
  if (!X) { if (root.console) root.console.error('mission-timeline.js needs js/mission-extras-core.js loaded first.'); return; }
  if (root.FZTimeline) return;

  var U = X.util, D = U.dom, F = U.fmt, h = D.h, NA = X.NA;
  var STATE_LABEL = { completed: 'Completed', active: 'Active', pending: 'Pending', failed: 'Failed', not_reached: 'Not reached', skipped: 'Skipped', planned: 'Planned' };
  var STATE_HELP = {
    completed: 'This phase finished.', active: 'The mission is in this phase at the replay position.', pending: 'This phase has not started yet.',
    failed: 'A failure stopped or interrupted this phase.', not_reached: 'The mission ended before this phase.', skipped: 'The objective was skipped.',
    planned: 'Planned only. No simulation progress is available for this phase.'
  };
  var KIND_LABEL = { start: 'Start', transit: 'Drive', work: 'Work', end: 'End' };
  var MISSION_STATE = {
    empty: ['No mission yet', 'Plan a mission and run the rehearsal to fill the timeline.'],
    configured: ['Configured', 'The mission is set up but no route has been planned yet.'],
    planned: ['Planned', 'A plan exists. Phase times are estimates; nothing has been simulated yet.'],
    running: ['Running', 'The rehearsal is playing.'], paused: ['Paused', 'The rehearsal is paused part-way.'],
    completed: ['Completed', 'The simulated mission finished.'], partial: ['Partial success', 'Some objectives were met before the mission ended.'],
    failed: ['Failed', 'The simulated mission did not meet its objectives.'], halted: ['Stopped by a failure', 'A failure stopped the simulated mission.'], aborted: ['Aborted', 'The mission was aborted.']
  };
  var inst = null;

  function mount(target, opts) {
    opts = opts || {};
    if (inst) return inst;
    var r = D.resolveHost(target, 'fz-timeline', opts.insert === false ? null : { after: 'rehearsal', title: 'Mission timeline', tag: 'Timeline', railLabel: 'Mission Timeline' });
    if (!r) return null;
    var host = r.host, S = { host: host, bundle: null, local: null, selected: null, sig: '', unsub: null, mode: opts.mode || null };
    var body = D.frame(host, host.id || 'fz-timeline', 'Mission timeline', 'Every phase of the mission in order, and where it stands. Pick a phase to see its events.', r.created);
    host.classList.add('fzx-host'); host.setAttribute('data-fzx', 'timeline');
    S.body = body; S.opts = opts;

    function bundleNow() {
      var ov = {}; if (S.local) ov.selectedStrategy = S.local; if (S.forceOutcome) ov.playback = { t_s: 0, playing: false };
      return Object.keys(ov).length ? X.getBundle(ov) : X.getBundle();
    }
    function render(b) {
      b = b || bundleNow(); S.bundle = b;
      var sig = [b.state, b.phase_mode, S.selected, S.local, b.selected, b.phases.map(function (p) { return p.id + ':' + p.state; }).join(','), b.events.length].join('|');
      if (sig === S.sig) { movePlayhead(b); return; }
      S.sig = sig; paint(b);
    }
    function movePlayhead(b) {
      var ph = S.body.querySelector('.fzx-playhead'); if (!ph) return;
      var pos = playPos(b); if (pos == null) { ph.hidden = true; return; } ph.hidden = false; ph.style.left = (pos * 100).toFixed(2) + '%';
      var c = S.body.querySelector('.fzx-clock'); if (c) c.textContent = F.clock(b.playback ? b.playback.t_s : 0);
    }
    function playPos(b) {
      if (b.phase_mode !== 'replay' || !b.playback || !b.timing || !U.isNum(b.timing.tEnd) || b.timing.tEnd <= 0) return null;
      return Math.max(0, Math.min(1, b.playback.t_s / b.timing.tEnd));
    }

    function paint(b) {
      D.clear(S.body);
      if (b.fixture) S.body.appendChild(D.fixtureBanner());
      if (!b.phases.length) {
        S.body.appendChild(D.empty(MISSION_STATE[b.state] ? MISSION_STATE[b.state][1] : 'No phases to show.', 'Needs a planned route (planning engine), a rehearsal run, or a simulation report. See FZExtras.setMission() in js/mission-extras-core.js.'));
        return;
      }
      S.body.appendChild(stateBanner(b));
      S.body.appendChild(controls(b));
      S.body.appendChild(stats(b));
      S.body.appendChild(track(b));
      S.body.appendChild(legendRow(b));
      var split = h('div', { class: 'fzx-split' }, [phaseList(b), detail(b)]);
      S.body.appendChild(split);
      S.body.appendChild(h('p', { class: 'src fzx-foot', text: footNote(b) }));
    }

    function stateBanner(b) {
      var m = MISSION_STATE[b.state] || [U.words(b.state), ''], o = b.outcome;
      var extra = [];
      if (o && U.isNum(o.progress)) extra.push(F.pct(o.progress, 1) + ' of the route driven');
      if (b.timing && U.isNum(b.timing.tEnd)) extra.push('span ' + F.dur(b.timing.tEnd));
      if (b.state_note) extra.push(b.state_note);
      var tone = b.state === 'completed' ? 'ok' : (b.state === 'partial' || b.state === 'paused' || b.state === 'running' || b.state === 'planned') ? 'warn' : (b.state === 'failed' || b.state === 'halted' || b.state === 'aborted') ? 'bad' : 'idle';
      return h('div', { class: 'fzx-state', 'data-tone': tone, role: 'status' }, [
        h('span', { class: 'fzx-state-chip', 'data-state': b.state, text: m[0] }),
        h('span', { class: 'fzx-state-txt', text: (o && o.reason && b.phase_mode === 'outcome' ? o.reason : m[1]) + (extra.length ? ' ' + extra.join(' · ') + '.' : '') })
      ]);
    }
    function controls(b) {
      var bar = h('div', { class: 'fzx-bar' });
      var avail = X.STRATS.filter(function (k) { return b.strategies.items[k] && b.strategies.items[k].present && b.strategies.items[k].feasible !== false; });
      if (b.phase_mode === 'plan' && avail.length > 1) {
        var seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Plan to show' });
        avail.forEach(function (k) {
          seg.appendChild(h('button', { type: 'button', class: b.route_strategy === k ? 'on' : null, 'aria-pressed': b.route_strategy === k ? 'true' : 'false', text: X.STRAT_LABEL[k] + (b.recommended === k ? ' (recommended)' : ''),
            onclick: function () { S.local = k; S.selected = null; S.sig = ''; render(); } }));
        });
        bar.appendChild(h('span', { class: 'fzx-bar-l', text: 'Plan for' })); bar.appendChild(seg);
      } else if (b.route_strategy) {
        bar.appendChild(h('span', { class: 'fzx-bar-l', text: 'Strategy' })); bar.appendChild(h('span', { class: 'fzx-pill', text: X.STRAT_LABEL[b.route_strategy] || b.route_strategy }));
      }
      if (b.phase_mode === 'replay' || (b.playback && b.sources.ui_run)) {
        var rp = b.phase_mode === 'replay';
        var seg2 = h('div', { class: 'seg', role: 'group', 'aria-label': 'Progress view' });
        [['replay', 'Replay position'], ['outcome', 'Final outcome']].forEach(function (m) {
          seg2.appendChild(h('button', { type: 'button', class: (rp ? 'replay' : 'outcome') === m[0] ? 'on' : null, 'aria-pressed': (rp ? 'replay' : 'outcome') === m[0] ? 'true' : 'false', text: m[1], title: m[0] === 'replay' ? 'Phase states follow the rehearsal clock.' : 'Phase states show how the finished run ended.',
            onclick: function () { S.forceOutcome = m[0] === 'outcome'; S.sig = ''; render(); } }));
        });
        bar.appendChild(h('span', { class: 'fzx-bar-l', text: 'Progress' })); bar.appendChild(seg2);
      }
      if (b.phase_mode === 'replay') bar.appendChild(h('span', { class: 'fzx-clock', 'aria-label': 'Replay clock', text: F.clock(b.playback ? b.playback.t_s : 0) }));
      return bar;
    }
    function stats(b) {
      var c = { completed: 0, active: 0, pending: 0, failed: 0, not_reached: 0, planned: 0, skipped: 0 };
      b.phases.forEach(function (p) { c[p.state] = (c[p.state] || 0) + 1; });
      var cells = [['Phases', String(b.phases.length)]];
      ['completed', 'active', 'pending', 'planned', 'failed', 'not_reached', 'skipped'].forEach(function (k) { if (c[k]) cells.push([STATE_LABEL[k], String(c[k])]); });
      var tot = b.phases.reduce(function (s, p) { return s + (U.isNum(p.duration_s) ? p.duration_s : 0); }, 0);
      if (tot > 0) cells.push([b.phase_mode === 'plan' ? 'Estimated span' : 'Span', F.dur(tot)]);
      return h('div', { class: 'stats fzx-stats', role: 'group', 'aria-label': 'Phase counts' }, cells.map(function (x) { return h('div', { class: 'stat' }, [h('b', { text: x[1] }), h('span', { text: x[0] })]); }));
    }
    function track(b) {
      var timed = b.phases.every(function (p) { return p.kind === 'start' || p.kind === 'end' || U.isNum(p.duration_s) || U.isNum(p.planned_duration_s); });
      var total = b.phases.reduce(function (s, p) { return s + (p.kind === 'start' || p.kind === 'end' ? 0 : (U.isNum(p.duration_s) ? p.duration_s : (U.isNum(p.planned_duration_s) ? p.planned_duration_s : 0))); }, 0);
      var wrap = h('div', { class: 'fzx-track-wrap' });
      var tr = h('ol', { class: 'fzx-track', 'aria-label': 'Mission phases in order' });
      b.phases.forEach(function (p) {
        var w = p.kind === 'start' || p.kind === 'end' ? 0 : (timed && total > 0 ? ((U.isNum(p.duration_s) ? p.duration_s : p.planned_duration_s) / total) : 1);
        var li = h('li', { class: 'fzx-seg', 'data-state': p.state, 'data-kind': p.kind, style: p.kind === 'start' || p.kind === 'end' ? null : 'flex:' + Math.max(w, 0.015).toFixed(4) + ' 1 0' }, [
          h('button', { type: 'button', 'aria-pressed': S.selected === p.id ? 'true' : 'false', 'aria-label': p.seq + '. ' + p.title + ', ' + (STATE_LABEL[p.state] || p.state), title: p.title + ' · ' + (STATE_LABEL[p.state] || p.state), onclick: function () { selectPhase(S.selected === p.id ? null : p.id); } }, [
            h('span', { class: 'fzx-seg-n', text: String(p.seq) })
          ])
        ]);
        tr.appendChild(li);
      });
      wrap.appendChild(tr);
      var pos = playPos(b);
      var ph = h('div', { class: 'fzx-playhead', 'aria-hidden': 'true', hidden: pos == null ? true : null, style: pos == null ? null : 'left:' + (pos * 100).toFixed(2) + '%' }); wrap.appendChild(ph);
      var ends = h('div', { class: 'fzx-axis src' }, [h('span', { text: timed && total > 0 && b.timing && U.isNum(b.timing.tEnd) ? F.clock(0) : 'Start' }), h('span', { text: timed && total > 0 ? (b.phase_mode === 'plan' ? 'Widths show estimated durations' : 'Widths show durations') : 'Widths are equal: durations are not available for every phase' }), h('span', { text: b.timing && U.isNum(b.timing.tEnd) ? F.clock(b.timing.tEnd) : 'End' })]);
      wrap.appendChild(ends);
      return wrap;
    }
    function legendRow(b) {
      var present = {}; b.phases.forEach(function (p) { present[p.state] = true; });
      var l = h('ul', { class: 'fzx-key', 'aria-label': 'Phase state key' });
      Object.keys(STATE_LABEL).forEach(function (k) { if (present[k]) l.appendChild(h('li', { title: STATE_HELP[k] }, [h('i', { 'data-state': k }), STATE_LABEL[k]])); });
      return l;
    }
    function timeText(p) {
      if (U.isNum(p.from_t_s) && U.isNum(p.to_t_s) && p.kind !== 'start' && p.kind !== 'end') return F.clock(p.from_t_s) + ' → ' + F.clock(p.to_t_s);
      if (U.isNum(p.from_t_s) && (p.kind === 'start' || p.kind === 'end')) return F.clock(p.from_t_s);
      if (U.isNum(p.from_t_s)) return 'from ' + F.clock(p.from_t_s);
      return 'Time not available';
    }
    function phaseList(b) {
      var ol = h('ol', { class: 'fzx-phases', 'aria-label': 'Phase list' });
      b.phases.forEach(function (p) {
        var nF = p.failures.length, nE = p.event_ids.length;
        var li = h('li', { class: 'fzx-phase', 'data-state': p.state, 'data-sel': S.selected === p.id ? 'true' : null }, [
          h('button', { type: 'button', class: 'fzx-phase-btn', 'aria-pressed': S.selected === p.id ? 'true' : 'false', onclick: function () { selectPhase(S.selected === p.id ? null : p.id); } }, [
            h('span', { class: 'fzx-phase-n', text: String(p.seq) }),
            h('span', { class: 'fzx-phase-main' }, [
              h('span', { class: 'fzx-phase-t', text: p.title }),
              h('span', { class: 'fzx-phase-s src', text: [KIND_LABEL[p.kind], p.subtitle].filter(Boolean).join(' · ') }),
              h('span', { class: 'fzx-phase-m src', text: [timeText(p), U.isNum(p.duration_s) && p.kind !== 'start' && p.kind !== 'end' ? F.dur(p.duration_s) : null, U.isNum(p.distance_m) ? F.dist(p.distance_m) : null].filter(Boolean).join(' · ') })
            ]),
            h('span', { class: 'fzx-phase-side' }, [
              h('span', { class: 'fzx-chip', 'data-state': p.state, title: STATE_HELP[p.state], text: STATE_LABEL[p.state] || p.state }),
              nE ? h('span', { class: 'fzx-count', title: nE + ' event(s) in this phase', text: nE + (nE === 1 ? ' event' : ' events') }) : null,
              nF ? h('span', { class: 'fzx-count fzx-count-bad', text: nF + (nF === 1 ? ' failure' : ' failures') }) : null
            ])
          ])
        ]);
        ol.appendChild(li);
      });
      return ol;
    }
    function detail(b) {
      var box = h('aside', { class: 'card fzx-detail', 'aria-live': 'polite', 'aria-label': 'Phase detail' });
      var p = b.phases.filter(function (x) { return x.id === S.selected; })[0];
      if (!p) { box.appendChild(h('h3', { text: 'Phase detail' })); box.appendChild(h('p', { class: 'src', text: 'Select a phase on the track or in the list to see its timing, basis and events.' })); return box; }
      box.appendChild(h('h3', { text: p.seq + '. ' + p.title }));
      box.appendChild(h('p', { class: 'src' }, [h('span', { class: 'fzx-chip', 'data-state': p.state, text: STATE_LABEL[p.state] }), ' ', STATE_HELP[p.state]]));
      var dl = h('dl', { class: 'fz-dl fzx-dl' });
      var add = function (k, v, basis) { if (v == null || v === NA) { dl.appendChild(h('dt', { text: k })); dl.appendChild(h('dd', { class: 'fz-na', text: NA })); return; } dl.appendChild(h('dt', { text: k })); dl.appendChild(h('dd', null, [v, basis ? ' ' : null, basis ? D.basisChip(basis) : null])); };
      add('Type', KIND_LABEL[p.kind]); add('Window', U.isNum(p.from_t_s) ? timeText(p) : null, p.basis);
      if (p.kind === 'transit' || p.kind === 'work') add('Duration', U.isNum(p.duration_s) ? F.dur(p.duration_s) : (U.isNum(p.planned_duration_s) ? F.dur(p.planned_duration_s) + ' planned' : null), p.basis);
      if (p.kind === 'transit') add('Distance', U.isNum(p.distance_m) ? F.dist(p.distance_m) : null, p.basis);
      box.appendChild(dl);
      if (p.note) box.appendChild(h('p', { class: 'src', text: p.note }));
      var evs = b.events.filter(function (e) { return p.event_ids.indexOf(e.id) >= 0; });
      box.appendChild(h('h4', { text: 'Events in this phase' }));
      if (!evs.length) box.appendChild(h('p', { class: 'src', text: b.events.length ? 'No events fall inside this phase.' : (b.sources.engine_plan && !b.sources.ui_run && !b.sources.report ? 'Planned phases have no simulation events.' : 'No events were recorded.') }));
      else {
        var ul = h('ul', { class: 'fzx-mini-log' });
        evs.slice(0, 12).forEach(function (e) { ul.appendChild(h('li', { 'data-s': e.severity }, [h('time', { text: F.clock(e.t_s) }), h('span', { class: 'fzx-sevdot', 'data-s': e.severity, 'aria-label': X.SEV_LABEL[e.severity] }), h('span', { text: e.title })])); });
        box.appendChild(ul);
        if (evs.length > 12) box.appendChild(h('p', { class: 'src', text: 'First 12 of ' + evs.length + ' events.' }));
        if (root.FZEventLog && typeof root.FZEventLog.setRange === 'function' && U.isNum(p.from_t_s)) {
          box.appendChild(h('button', { type: 'button', class: 'fz-btn ghost fzx-btn', text: 'Show in event log', onclick: function () { root.FZEventLog.setRange(p.from_t_s, U.isNum(p.to_t_s) ? p.to_t_s : p.from_t_s, p.title); var el = root.document.getElementById('fz-eventlog'); if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }));
        }
      }
      return box;
    }
    function footNote(b) {
      var parts = [];
      if (b.phase_mode === 'plan') parts.push('Planned phases use estimates from an assumed vehicle model. Dwell time per site is an assumption of the planning engine.');
      else parts.push('Phase timing and states are simulated with an assumed model. They are not measurements.');
      if (b.route && b.route.source) parts.push('Source: ' + ({ 'engine-plan': 'planning engine plan', 'ui-run': 'rehearsal run', 'ui-plan': 'plan summary' }[b.route.source] || b.route.source) + '.');
      else if (b.sources.report) parts.push('Source: simulation report.');
      return parts.join(' ');
    }

    function selectPhase(id) {
      S.selected = id; S.sig = ''; render(S.bundle);
      var p = S.bundle && S.bundle.phases.filter(function (x) { return x.id === id; })[0] || null;
      try { root.document.dispatchEvent(new root.CustomEvent('fz:phase-select', { detail: p ? { phase: p, from_t_s: p.from_t_s, to_t_s: p.to_t_s } : { phase: null } })); } catch (e) { /* no CustomEvent */ }
    }
    S.render = render; S.selectPhase = selectPhase;
    S.unsub = X.subscribe(function (b) { render((S.local || S.forceOutcome) ? bundleNow() : b); });
    render();
    inst = { host: host, render: render, selectPhase: selectPhase, unmount: function () { if (S.unsub) S.unsub(); D.clear(S.body); inst = null; root.FZTimeline._inst = null; } };
    root.FZTimeline._inst = inst;
    return inst;
  }

  root.FZTimeline = { version: '1.0.0', mount: mount, render: function (b) { if (inst) inst.render(b); }, selectPhase: function (id) { if (inst) inst.selectPhase(id); }, unmount: function () { if (inst) inst.unmount(); }, _inst: null };
})(typeof window !== 'undefined' ? window : globalThis);
