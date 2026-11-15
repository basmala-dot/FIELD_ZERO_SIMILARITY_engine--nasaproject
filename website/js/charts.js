/*! FIELD//ZERO charts (Chart.js). Every series is read from FieldZeroData.data or the similarity analysis. Nothing is generated. */
(function (root) {
  'use strict';
  var COL = { earth: '#5E9C9A', mars: '#B65F43', moon: '#4A6FA5' }, NAME = { earth: 'Earth (Western Desert)', mars: 'Mars (Jezero)', moon: 'Moon (Taurus-Littrow)' };
  var MET = { slope_deg: ['Slope', '°'], roughness_std: ['Roughness (local std of elevation)', 'm'], elev_variability_std: ['Elevation variability (broad-window std)', 'm'], tri: ['Terrain Ruggedness Index', 'm'] };
  var SRC = 'Source: FIELD//ZERO processed terrain (NASADEM, CTX DEM 20 m, LOLA 118 m), ';
  var charts = [], FZ, host;
  var f = function (v, d) { return v == null ? 'n/a' : (+v).toFixed(d == null ? 2 : d); };
  var pct = function (a, b) { return a.length ? (100 * a.length / b).toFixed(1) : '0'; };

  function card(title, units, why, src, ctl) {
    var d = document.createElement('div'); d.className = 'card chartcard';
    d.innerHTML = '<h3>' + title + '</h3><p><b>' + units + '</b> ' + why + '</p>' + (ctl ? '<select aria-label="' + title + ' options">' + ctl.map(function (o) { return '<option value="' + o[0] + '">' + o[1] + '</option>'; }).join('') + '</select>' : '') + '<canvas role="img" aria-label="' + title + '"></canvas><p class="why"></p><p class="src">' + src + '</p>';
    host.appendChild(d); return { el: d, cv: d.querySelector('canvas'), sel: d.querySelector('select'), why: d.querySelector('.why') };
  }
  function draw(c, cfg) {
    if (c.chart) { c.chart.destroy(); charts.splice(charts.indexOf(c.chart), 1); }
    cfg.options = Object.assign({ responsive: true, animation: { duration: 700, easing: 'easeOutQuart' }, plugins: {} }, cfg.options || {});
    c.chart = new Chart(c.cv, cfg); charts.push(c.chart);
  }
  var axis = function (t) { return { title: { display: true, text: t } }; };
  function hist(vals, lo, hi, n) { var h = new Array(n).fill(0), w = (hi - lo) / n, tot = 0; vals.forEach(function (v) { if (v == null || v < lo || v > hi) return; tot++; h[Math.min(n - 1, Math.floor((v - lo) / w))]++; }); return { h: h.map(function (c) { return tot ? 100 * c / tot : 0; }), w: w, tot: tot }; }
  function props(b, k) { var g = FZ.data.terrain[b][120].geojson; return g ? g.features.map(function (x) { return x.properties[k]; }) : []; }

  function A() {
    var rows = FZ.data.comparison[120] && FZ.data.comparison[120].rows, c = card('A. Terrain comparison: Earth vs Mars vs Moon', 'Mean value at 120 m, units per metric.', 'Compares terrain shape only. Elevation is excluded because each body has its own vertical datum.', SRC + 'comparison_120m.csv.',
      Object.keys(MET).map(function (k) { return [k, MET[k][0] + ' (' + MET[k][1] + ')']; }));
    if (!rows) { c.why.textContent = 'comparison_120m.csv is not loaded.'; return; }
    var go = function () { var k = c.sel.value, by = {}; rows.forEach(function (r) { by[r.body] = r; });
      draw(c, { type: 'bar', data: { labels: ['earth', 'mars', 'moon'].map(function (b) { return NAME[b]; }), datasets: [{ label: 'Mean ' + MET[k][0] + ' (' + MET[k][1] + ')', data: ['earth', 'mars', 'moon'].map(function (b) { return by[b] ? by[b][k + '_mean'] : null; }), backgroundColor: ['earth', 'mars', 'moon'].map(function (b) { return COL[b]; }), borderRadius: 8 }] },
        options: { scales: { y: Object.assign({ beginAtZero: true }, axis(MET[k][0] + ' (' + MET[k][1] + ')')) }, plugins: { tooltip: { callbacks: { afterLabel: function (t) { var b = ['earth', 'mars', 'moon'][t.dataIndex]; return by[b] ? 'std ' + f(by[b][k + '_std']) + ' ' + MET[k][1] + ' · ' + by[b].valid_cells + ' valid cells' : ''; } } } } } }); };
    c.sel.onchange = go; go();
  }
  function B() {
    var c = card('B. Terrain distributions', 'Share of valid cells (%) per bin; metric units on the x-axis.', 'The Moon and Mars have long rugged tails; Earth\'s site is flatter. Shared bins run from 0 to the pooled 99th percentile.', SRC + 'decimated 120 m GeoJSON (Earth ' + props('earth', 'slope_deg').length + ', Mars ' + props('mars', 'slope_deg').length + ', Moon ' + props('moon', 'slope_deg').length + ' cells; null border cells excluded).',
      Object.keys(MET).map(function (k) { return [k, MET[k][0] + ' (' + MET[k][1] + ')']; }));
    var go = function () { var k = c.sel.value, all = {}, pool = [];
      ['earth', 'mars', 'moon'].forEach(function (b) { all[b] = props(b, k).filter(function (v) { return v != null; }); pool = pool.concat(all[b]); });
      if (!pool.length) { c.why.textContent = 'No values loaded.'; return; }
      pool.sort(function (a, b) { return a - b; }); var hi = pool[Math.floor(.99 * (pool.length - 1))], n = 24, w = hi / n;
      draw(c, { type: 'bar', data: { labels: Array.from({ length: n }, function (_, i) { return f(i * w, 1); }), datasets: ['earth', 'mars', 'moon'].map(function (b) { return { label: NAME[b], data: hist(all[b], 0, hi, n).h, backgroundColor: COL[b] + 'bb' }; }) },
        options: { scales: { x: axis(MET[k][0] + ' (' + MET[k][1] + '), bin start'), y: axis('% of valid cells') }, plugins: { tooltip: { callbacks: { label: function (t) { return t.dataset.label + ': ' + f(t.parsed.y, 1) + ' % of cells'; } } } } } }); };
    c.sel.onchange = go; go();
  }
  function C() {
    var S = FZ.analysis.scale_comparison, D = FZ.data.terrain, c = card('C1. Resolution agreement (120 m vs 360 m)', 'Percent of 120 m cells whose score is within ±15 points of their 360 m parent cell.', '', 'Source: similarity engine scale comparison (analysis.scale_comparison).');
    draw(c, { type: 'bar', data: { labels: ['Earth to Mars score', 'Earth to Moon score'], datasets: [{ label: '% consistent', data: [S.mars.fraction_consistent * 100, S.moon.fraction_consistent * 100], backgroundColor: [COL.mars, COL.moon], borderRadius: 8 }] }, options: { scales: { y: Object.assign({ min: 0, max: 100 }, axis('% of cells consistent')) }, plugins: { legend: { display: false } } } });
    var div = function (t) { return FZ.analysis.candidates[t].primary.filter(function (x) { return x.scale_check && x.scale_check.consistency === 'divergent'; }).length; };
    c.why.innerHTML = 'Only ' + f(S.mars.fraction_consistent * 100, 0) + ' % (Mars) and ' + f(S.moon.fraction_consistent * 100, 0) + ' % (Moon) of cells agree across resolution. Parent/child rank correlation (Spearman) is ' + f(S.mars.spearman_parent_childmean_vs_coarse) + ' and ' + f(S.moon.spearman_parent_childmean_vs_coarse) + '. <span class="warn">Unstable:</span> ' + div('mars') + ' of 10 Mars and ' + div('moon') + ' of 10 Moon top candidates are flagged divergent. Treat scores as scale-dependent.';
    var c2 = card('C2. Mean slope by resolution', 'Mean slope (°) from the full-grid summaries.', 'Coarser cells average out small features, so slopes drop with scale; the drop differs by body because source DEM resolutions differ.', SRC + '*_terrain_summary.json (120 m and 360 m).');
    var g = function (b, s) { var m = D[b][s] && D[b][s].summary; return m && m.slope_deg ? m.slope_deg.mean : null; };
    draw(c2, { type: 'bar', data: { labels: ['earth', 'mars', 'moon'].map(function (b) { return NAME[b]; }), datasets: [120, 360].map(function (s, i) { return { label: s + ' m', data: ['earth', 'mars', 'moon'].map(function (b) { return g(b, s); }), backgroundColor: i ? '#C9A24A' : '#14213D', borderRadius: 6 }; }) }, options: { scales: { y: Object.assign({ beginAtZero: true }, axis('Mean slope (°)')) } } });
  }
  function Dc() {
    var cl = FZ.data.climate.earth, c = card('D. Earth climate: NASA POWER daily records', 'Daily values at one grid point, 2023; units shown per variable.', '', SRC.replace('FIELD//ZERO processed terrain (NASADEM, CTX DEM 20 m, LOLA 118 m), ', 'NASA POWER daily point API (reanalysis/satellite-derived, not station data), ') + 'earth_western_desert_power_daily.csv.', cl && cl.daily ? cl.daily.columns.filter(function (x) { return x !== 'date'; }).map(function (k) { return [k, k + (cl.summary && cl.summary[k] ? ' (' + cl.summary[k].units + ')' : '')]; }) : null);
    if (!cl || !cl.daily) { c.why.textContent = 'No climate data loaded.'; return; }
    var miss = (cl.missingVariables || []).map(function (m) { return m.name; });
    var go = function () { var k = c.sel.value, u = cl.summary[k] ? cl.summary[k].units : '', rows = cl.daily.rows;
      draw(c, { type: 'line', data: { labels: rows.map(function (r) { var s = String(r.date); return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6); }), datasets: [{ label: k + ' (' + u + ')', data: rows.map(function (r) { return r[k]; }), borderColor: COL.earth, backgroundColor: COL.earth + '33', pointRadius: 0, borderWidth: 1.6, tension: .25, fill: true }] }, options: { scales: { x: { ticks: { maxTicksLimit: 8 } }, y: axis(k + ' (' + u + ')') } } });
      var s = cl.summary[k]; c.why.textContent = s ? 'n = ' + s.n + ' days · mean ' + f(s.mean) + ' · min ' + f(s.min) + ' · max ' + f(s.max) + ' ' + u + '.' : ''; };
    var note = document.createElement('p'); note.className = 'warn'; note.textContent = 'Missing: ' + (miss.join(', ') || 'none') + ' (T2M mean temperature is not in the files and is not derived here). Mars and Moon have no climate datasets.'; c.el.insertBefore(note, c.cv);
    c.sel.onchange = go; go();
  }
  function E() {
    var R = FZ.analysis.results, h = {}, c = card('E1. Similarity score distributions', 'Share of scored Earth cells (%) per 5-point score bin; score is 0-100.', 'Scores near 100 mean terrain metrics sit near the reference median. This is statistical closeness, not proof of analog status.', 'Source: similarity engine, ' + R.mars[120].stats.n_scored + ' scored 120 m cells per target.');
    ['mars', 'moon'].forEach(function (t) { h[t] = hist(R[t][120].cells.map(function (x) { return x.status === 'scored' ? x.score : null; }), 0, 100.0001, 20).h; });
    draw(c, { type: 'bar', data: { labels: Array.from({ length: 20 }, function (_, i) { return i * 5 + '-' + (i * 5 + 5); }), datasets: ['mars', 'moon'].map(function (t) { return { label: 'Earth to ' + t[0].toUpperCase() + t.slice(1), data: h[t], backgroundColor: COL[t] + 'bb' }; }) }, options: { scales: { x: axis('Similarity score (0-100)'), y: axis('% of scored cells') } } });
    var c2 = card('E2. Feature contribution breakdown', 'Points of the 0-100 overall score contributed by each feature.', 'Contributions sum to the candidate\'s score. Weights are expert-judgement defaults (slope 0.30, roughness 0.20, elevation variability 0.30, TRI 0.20).', 'Source: similarity engine top candidates (120 m).', [['mars', 'Earth to Mars'], ['moon', 'Earth to Moon']]);
    var go2 = function () { var t = c2.sel.value, cs = FZ.analysis.candidates[t].primary, fc = ['#5E9C9A', '#D08A4E', '#4A6FA5', '#B65F43'];
      draw(c2, { type: 'bar', data: { labels: cs.map(function (x) { return '#' + x.candidate_rank; }), datasets: Object.keys(MET).map(function (k, i) { return { label: MET[k][0].split(' (')[0], data: cs.map(function (x) { return x.features[k] ? x.features[k].contribution : null; }), backgroundColor: fc[i] }; }) }, options: { scales: { x: Object.assign({ stacked: true }, axis('Candidate rank')), y: Object.assign({ stacked: true }, axis('Score points')) } } }); };
    c2.sel.onchange = go2; go2();
    var c3 = card('E3. Top candidates: 120 m vs 360 m score', 'Overall score (0-100) at both resolutions.', 'Large gaps mean the candidate depends on the resolution used.', 'Source: similarity engine candidates and their scale_check.', [['mars', 'Earth to Mars'], ['moon', 'Earth to Moon']]);
    var go3 = function () { var t = c3.sel.value, cs = FZ.analysis.candidates[t].primary;
      draw(c3, { type: 'bar', data: { labels: cs.map(function (x) { return '#' + x.candidate_rank; }), datasets: [{ label: '120 m', data: cs.map(function (x) { return x.score; }), backgroundColor: '#14213D' }, { label: '360 m parent', data: cs.map(function (x) { return x.scale_check ? x.scale_check.score_360m : null; }), backgroundColor: '#C9A24A' }] }, options: { scales: { y: Object.assign({ min: 0, max: 100 }, axis('Score (0-100)')), x: axis('Candidate rank') } } }); };
    c3.sel.onchange = go3; go3();
  }
  root.FZCharts = { render: function (fz, el) {
    FZ = fz; host = el; charts.forEach(function (c) { c.destroy(); }); charts = []; el.innerHTML = '';
    if (!root.Chart) { el.innerHTML = '<p>The chart library did not load (offline?). Tables and maps still work.</p>'; return; }
    Chart.defaults.color = '#ece4d0'; Chart.defaults.borderColor = 'rgba(255,255,255,.14)'; Chart.defaults.font.family = "'Public Sans',sans-serif";
    [A, B, C, Dc, E].forEach(function (fn) { try { fn(); } catch (e) { var p = document.createElement('p'); p.className = 'warn'; p.textContent = 'A chart could not be drawn: ' + e.message; el.appendChild(p); console.error(e); } });
  } };
})(window);
