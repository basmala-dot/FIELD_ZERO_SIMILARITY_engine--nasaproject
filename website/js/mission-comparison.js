/*! FIELD//ZERO strategy comparison (v1.0.0)
 *
 *  Side-by-side visual comparison of the FAST, SAFE and SCIENTIFIC strategies. Complements the strategy cards in
 *  mission-ui.js with aligned bars, a best-in-row marker, a difference view, the engine's own trade-off statements and
 *  a same-goal route comparison.
 *
 *  DATA INTEGRITY
 *    Only metrics the engine actually reported are drawn, each tagged with its basis (estimate, heuristic, model...).
 *    A metric no strategy has is listed under "Not reported" and is never filled in. Cost and success probability are
 *    NOT produced by the planning engine; they appear only when a contract-1.0 plan supplies them.
 *    "Best" is judged per row by direction (lower is better for time, distance, energy, cost, risk; higher for
 *    similarity, science score, success, margin). Sites visited has no direction and is never marked best.
 *    No overall winner is computed here: the engine's recommendation and weighted score are shown as reported.
 *
 *  PUBLIC SURFACE   window.FZComparison
 *    mount(target?, options?)  target element/selector; else #fz-comparison; else inserts a chapter after #strategy.
 *    render(bundle?)  unmount()
 *  EVENTS (document)  fz:strategy-focus { strategy }  when a strategy header is clicked (view only; it does not
 *  change the mission's chosen strategy).
 *
 *  Needs: js/mission-extras-core.js first, css/mission-extras.css.
 */
(function (root) {
  'use strict';
  var X = root.FZExtras;
  if (!X) { if (root.console) root.console.error('mission-comparison.js needs js/mission-extras-core.js loaded first.'); return; }
  if (root.FZComparison) return;

  var U = X.util, D = U.dom, F = U.fmt, h = D.h, NA = X.NA;
  var inst = null;

  function fmtMetric(m, v, cur) {
    switch (m.kind) {
      case 'dur': return F.dur(v); case 'dist': return F.dist(v); case 'wh': return F.wh(v); case 'money': return F.money(v, cur);
      case 'pct': return F.pctRaw(v, 0); case 'frac': return F.pct(v, 0); case 'int': return String(Math.round(v)); default: return U.num(v, 1);
    }
  }
  function fmtDelta(m, d, cur) {
    if (!U.isNum(d)) return NA; if (Math.abs(d) < 1e-9) return 'same';
    var s = d > 0 ? '+' : '−', a = Math.abs(d);
    switch (m.kind) {
      case 'dur': return s + F.dur(a); case 'dist': return s + F.dist(a); case 'wh': return s + F.wh(a); case 'money': return s + F.money(a, cur);
      case 'pct': return s + a.toFixed(0) + ' pts'; case 'frac': return s + (a * 100).toFixed(0) + ' pts'; case 'int': return s + Math.round(a); default: return s + U.num(a, 1);
    }
  }

  function mount(target, opts) {
    opts = opts || {};
    if (inst) return inst;
    var r = D.resolveHost(target, 'fz-comparison', opts.insert === false ? null : { after: 'strategy', title: 'Strategy comparison', tag: 'Compare', railLabel: 'Strategy Comparison (visual)' });
    if (!r) return null;
    var host = r.host, S = { baseline: null, diff: false, sig: '', bundle: null };
    var body = D.frame(host, host.id || 'fz-comparison', 'Fast, safe or scientific?', 'The same mission under three strategies, measured on what the engine actually reports.', r.created);
    host.classList.add('fzx-host'); host.setAttribute('data-fzx', 'comparison'); S.body = body;

    function render(b) {
      b = b || X.getBundle(); S.bundle = b;
      var sig = JSON.stringify([b.strategies.items, b.selected, S.baseline, S.diff, b.fixture]); if (sig === S.sig) return; S.sig = sig; paint(b);
    }
    function paint(b) {
      D.clear(S.body); var st = b.strategies;
      if (b.fixture) S.body.appendChild(D.fixtureBanner());
      var present = X.STRATS.filter(function (k) { return st.items[k].present; });
      if (!st.available || !present.length) {
        S.body.appendChild(D.empty('No strategy results yet.', 'Run the mission planner so the engine can produce FAST, SAFE and SCIENTIFIC plans. See FZExtras.setMission({ plan }) in js/mission-extras-core.js.'));
        return;
      }
      var cols = present, cur = st.currency;
      if (!S.baseline || cols.indexOf(S.baseline) < 0) S.baseline = (st.recommended && cols.indexOf(st.recommended) >= 0) ? st.recommended : cols[0];
      S.body.appendChild(headers(b, cols));
      if (cols.length < 2) S.body.appendChild(h('p', { class: 'src', text: 'Only one strategy has results, so there is nothing to compare yet.' }));
      S.body.appendChild(toolbar(cols));
      var grid = h('div', { class: 'fzx-cmp', style: '--cols:' + cols.length, role: 'table', 'aria-label': 'Strategy metrics' });
      var missing = [], lastGroup = null, feasibleCols = cols.filter(function (k) { return st.items[k].feasible !== false; });
      grid.appendChild(h('div', { class: 'fzx-cmp-r fzx-cmp-h', role: 'row' }, [h('span', { role: 'columnheader', text: 'Metric' })].concat(cols.map(function (k) { return h('span', { role: 'columnheader', 'data-k': k, text: X.STRAT_LABEL[k] }); }))));
      X.METRICS.forEach(function (m) {
        var vals = cols.map(function (k) { var x = st.items[k].metrics[m.id]; return x && st.items[k].feasible !== false ? x : null; });
        if (!vals.some(Boolean)) { missing.push(m); return; }
        if (m.group !== lastGroup) { lastGroup = m.group; grid.appendChild(h('div', { class: 'fzx-cmp-g', role: 'row' }, [h('span', { role: 'rowheader', text: m.group })])); }
        grid.appendChild(row(m, cols, vals, cur));
      });
      S.body.appendChild(grid);
      if (missing.length) S.body.appendChild(h('p', { class: 'fzx-missing src' }, [h('b', { text: 'Not reported by the engine: ' }), missing.map(function (m) { return m.label.toLowerCase(); }).join(', ') + '. These are left out, not estimated.']));
      var legendKinds = {}; cols.forEach(function (k) { Object.keys(st.items[k].metrics).forEach(function (id) { var x = st.items[k].metrics[id]; if (x) legendKinds[x.basis] = true; }); });
      S.body.appendChild(D.legend(Object.keys(legendKinds)));
      var infeas = cols.filter(function (k) { return st.items[k].feasible === false; });
      infeas.forEach(function (k) { S.body.appendChild(h('div', { class: 'fz-alert', 'data-kind': 'warn' }, [h('span', { text: X.STRAT_LABEL[k] + ' has no feasible plan: ' + (st.items[k].reason || 'the engine gave no reason.') })])); });
      S.body.appendChild(insight(b));
      if (st.same_goal) S.body.appendChild(sameGoal(st.same_goal, cols));
    }
    function headers(b, cols) {
      var st = b.strategies, wrap = h('div', { class: 'fzx-heads', style: '--cols:' + cols.length });
      cols.forEach(function (k) {
        var it = st.items[k], rec = st.recommended === k, sel = b.selected === k;
        var bestN = st.best_by ? Object.keys(st.best_by).filter(function (x) { return st.best_by[x] === k; }).map(function (x) { return x.replace(/_/g, ' '); }) : [];
        var sc = it.scores && U.isNum(it.scores.total) ? it.scores.total : null;
        wrap.appendChild(h('button', { type: 'button', class: 'fzx-head', 'data-k': k, 'data-infeasible': it.feasible === false ? 'true' : null, 'aria-pressed': S.baseline === k ? 'true' : 'false', title: 'Use as the baseline for the difference view',
          onclick: function () { S.baseline = k; S.sig = ''; render(S.bundle); try { root.document.dispatchEvent(new root.CustomEvent('fz:strategy-focus', { detail: { strategy: k } })); } catch (e) { /* ignore */ } } }, [
          h('span', { class: 'fzx-head-t', text: it.label }),
          h('span', { class: 'fzx-head-badges' }, [rec ? h('span', { class: 'fzx-tag fzx-tag-rec', text: 'Engine recommends' }) : null, sel ? h('span', { class: 'fzx-tag', text: 'Chosen for mission' }) : null, it.feasible === false ? h('span', { class: 'fzx-tag fzx-tag-bad', text: 'Not feasible' }) : null]),
          it.intent ? h('span', { class: 'fzx-head-i src', text: it.intent }) : null,
          h('span', { class: 'fzx-head-m src', text: [it.risk_class ? 'Risk: ' + it.risk_class : null, it.confidence ? 'Confidence: ' + it.confidence : null, sc != null ? 'Priority score ' + sc.toFixed(2) + ' (heuristic)' : null].filter(Boolean).join(' · ') }),
          bestN.length ? h('span', { class: 'fzx-head-b src', text: 'Best at: ' + bestN.join(', ') }) : null
        ]));
      });
      return wrap;
    }
    function toolbar(cols) {
      var bar = h('div', { class: 'fzx-bar' });
      var seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Display' });
      [[false, 'Values'], [true, 'Difference from baseline']].forEach(function (o) { seg.appendChild(h('button', { type: 'button', class: S.diff === o[0] ? 'on' : null, 'aria-pressed': S.diff === o[0] ? 'true' : 'false', text: o[1], onclick: function () { S.diff = o[0]; S.sig = ''; render(S.bundle); } })); });
      bar.appendChild(seg);
      if (S.diff && cols.length > 1) bar.appendChild(h('span', { class: 'src', text: 'Baseline: ' + X.STRAT_LABEL[S.baseline] + '. Click a strategy heading to change it.' }));
      return bar;
    }
    function row(m, cols, vals, cur) {
      var nums = vals.filter(Boolean).map(function (x) { return x.v; });
      var max = m.scale || Math.max.apply(null, nums.concat([0])) || 1;
      var best = null; if (m.better && nums.length > 1) best = m.better === 'lower' ? Math.min.apply(null, nums) : Math.max.apply(null, nums);
      var tie = best !== null && nums.filter(function (v) { return v === best; }).length === nums.length;
      var bi = cols.indexOf(S.baseline), base = vals[bi] ? vals[bi].v : null;
      var rowEl = h('div', { class: 'fzx-cmp-r', role: 'row' }, [h('span', { class: 'fzx-cmp-l', role: 'rowheader', title: m.help }, [m.label, m.better ? h('i', { class: 'fzx-dir', text: m.better === 'lower' ? 'lower is better' : 'higher is better' }) : null])]);
      cols.forEach(function (k, i) {
        var x = vals[i], isBest = x && best !== null && !tie && x.v === best;
        if (!x) { rowEl.appendChild(h('span', { class: 'fzx-cell fz-na', role: 'cell', 'data-k': k }, [h('span', { class: 'fzx-v', text: NA }), h('span', { class: 'src', text: 'not reported' })])); return; }
        var cell = h('span', { class: 'fzx-cell', role: 'cell', 'data-k': k, 'data-best': isBest ? 'true' : null });
        var val = S.diff ? (i === bi ? 'baseline' : fmtDelta(m, base == null ? null : x.v - base, cur)) : fmtMetric(m, x.v, cur);
        var tone = null; if (S.diff && i !== bi && base != null && m.better && Math.abs(x.v - base) > 1e-9) tone = ((x.v < base) === (m.better === 'lower')) ? 'good' : 'bad';
        cell.appendChild(h('span', { class: 'fzx-v', 'data-tone': tone, text: val }));
        if (isBest && !S.diff) cell.appendChild(h('span', { class: 'fzx-best', text: 'Best' }));
        cell.appendChild(h('span', { class: 'fzx-bar-o', 'aria-hidden': 'true' }, [h('i', { style: 'width:' + Math.max(1, Math.min(100, (x.v / max) * 100)).toFixed(1) + '%' })]));
        if (S.diff && i !== bi) cell.appendChild(h('span', { class: 'src', text: fmtMetric(m, x.v, cur) }));
        cell.appendChild(h('span', { class: 'fzx-cell-b' }, [D.basisChip(x.basis, x.note)]));
        rowEl.appendChild(cell);
      });
      return rowEl;
    }
    function insight(b) {
      var st = b.strategies, box = h('div', { class: 'fzx-insight' });
      if (st.recommendation && st.recommendation.rationale) {
        box.appendChild(h('div', { class: 'card' }, [h('h3', { text: 'Engine recommendation' }), h('p', { text: st.recommendation.rationale }),
          st.recommendation.based_on ? h('p', { class: 'src', text: 'Based on: ' + st.recommendation.based_on + '. Scores are heuristic and relative to the strategies compared.' }) : null,
          U.arr(st.caveats).length ? h('ul', { class: 'fzx-list' }, st.caveats.map(function (c) { return h('li', { text: c }); })) : null]));
      }
      if (st.tradeoffs.length) box.appendChild(h('div', { class: 'card' }, [h('h3', { text: 'Trade-offs' }), h('ul', { class: 'fzx-list' }, st.tradeoffs.map(function (t) { return h('li', { text: t }); }))]));
      return box;
    }
    function sameGoal(sg, cols) {
      var rows = [['Distance', 'distance_m', F.dist], ['Drive time', 'est_drive_time_h', function (v) { return F.dur(v * 3600); }], ['Energy', 'est_energy_wh', F.wh], ['Steepest grade', 'max_travel_grade_deg', function (v) { return U.num(v, 1) + '°'; }], ['Route risk index', 'route_risk_index', function (v) { return U.num(v, 1); }]];
      var ks = cols.filter(function (k) { return sg.per_strategy[k] && sg.per_strategy[k].status === 'ok'; });
      if (!ks.length) return h('span');
      var t = h('table', { class: 'fzx-sg' }, [h('thead', null, [h('tr', null, [h('th', { scope: 'col', text: 'Same start, same goal' })].concat(ks.map(function (k) { return h('th', { scope: 'col', text: X.STRAT_LABEL[k] }); })))])]);
      var tb = h('tbody');
      rows.forEach(function (r) {
        var vs = ks.map(function (k) { return sg.per_strategy[k][r[1]]; }); if (!vs.some(U.isNum)) return;
        var min = Math.min.apply(null, vs.filter(U.isNum));
        tb.appendChild(h('tr', null, [h('th', { scope: 'row', text: r[0] })].concat(vs.map(function (v) { return h('td', { 'data-trend': U.isNum(v) && v === min && vs.length > 1 && vs.filter(function (x) { return x === min; }).length < vs.length ? 'good' : null, text: U.isNum(v) ? r[2](v) : NA }); }))));
      });
      t.appendChild(tb);
      return h('div', { class: 'fzx-samegoal' }, [h('h3', { text: 'Route cost model only' }), h('p', { class: 'src', text: (sg.note || '') + ' Green marks the lowest value in a row. All values are estimates.' }), h('div', { class: 'scroll' }, [t])]);
    }
    var unsub = X.subscribe(function (b) { render(b); });
    render();
    inst = { host: host, render: render, unmount: function () { unsub(); D.clear(S.body); inst = null; } };
    return inst;
  }
  root.FZComparison = { version: '1.0.0', mount: mount, render: function (b) { if (inst) inst.render(b); }, unmount: function () { if (inst) inst.unmount(); } };
})(typeof window !== 'undefined' ? window : globalThis);
