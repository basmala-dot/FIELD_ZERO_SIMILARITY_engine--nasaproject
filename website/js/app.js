/*! FIELD//ZERO app: one data interface (window.FZ) shared by map, charts and mission intelligence. */
(function () {
  'use strict';
  var FZ = window.FZ = { data: null, analysis: null, rows: null, portfolio: null, gaps: null, target: 'mars', scale: 120, pinned: [], report: null };
  var $ = function (id) { return document.getElementById(id); };
  var f = function (v, d) { return v == null ? 'n/a' : (+v).toFixed(d == null ? 2 : d); };
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var UNITS = { slope_deg: ['Slope', '°'], roughness_std: ['Roughness', 'm'], tri: ['TRI', 'm'], elev_variability_std: ['Elevation variability', 'm'] };
  var FN = ['slope_deg', 'roughness_std', 'elev_variability_std', 'tri'];
  var TN = { mars: 'Mars (Jezero)', moon: 'Moon (Taurus-Littrow)' };

  function seg(id, opts, cur, cb) {
    var el = $(id); el.innerHTML = opts.map(function (o) { return '<button data-v="' + o[0] + '" class="' + (String(o[0]) === String(cur) ? 'on' : '') + '">' + o[1] + '</button>'; }).join('');
    el.onclick = function (e) { var b = e.target.closest('button'); if (!b) return; [].forEach.call(el.children, function (x) { x.classList.toggle('on', x === b); }); cb(b.dataset.v); };
  }
  function fail(e) {
    console.error(e); var h = (e && e.hint) || (location.protocol === 'file:' ? 'Open this page through a web server (VS Code Live Server with the project root as the workspace), not by double-clicking.' : '');
    $('boot-msg').innerHTML = '<b>Could not load the data.</b><br>' + esc(e && e.message || e) + '<br>' + esc(h);
  }

  // ---------------------------------------------------------------- boot
  async function boot() {
    try {
      var D = FieldZeroData; await D.init(); $('boot-msg').textContent = 'Reading terrain grids…';
      await D.loadAll(); await D.load('earth_120m_terrain_csv'); await D.load('earth_360m_terrain_csv');
      FZ.report = D.report(); FZ.data = D.data; FZ.rows = D.data.terrain.earth[120].csv.rows;
      $('boot-msg').textContent = 'Scoring Earth cells with the similarity engine…'; await new Promise(function (r) { setTimeout(r, 30); });
      FZ.analysis = FieldZeroSimilarity.analyzeLoaded(D.data);
      FZ.gaps = FieldZeroIntel.evidenceGaps(D.data);
    } catch (e) { document.dispatchEvent(new CustomEvent('fz:data-failed', { detail: { message: String(e && e.message || e) } })); return fail(e); }
    [control, explorer, discovery, function () { FZCharts.render(FZ, $('charts')); }, portfolioUI, evidence, brief, nav].forEach(function (fn) { try { fn(); } catch (e) { console.error('Section failed:', e); } });   // one failing chapter must not blank the others
    $('boot').classList.add('done'); setTimeout(function () { $('boot').remove(); }, 700);
    document.dispatchEvent(new CustomEvent('fz:data-ready'));   // mission-ui.js waits for this before it unlocks planning
  }

  // ---------------------------------------------------------------- I Mission Control
  function control() {
    var cmp = {}; (FZ.data.comparison[120].rows || []).forEach(function (r) { cmp[r.body] = r; });
    var R = FZ.analysis.results, st = R.mars[120].stats, rp = FZ.report;
    $('stats').innerHTML = [[cmp.earth.valid_cells, 'Earth cells at 120 m'], [cmp.mars.valid_cells, 'Mars cells (Jezero)'], [cmp.moon.valid_cells, 'Moon cells (Taurus-Littrow)'], [st.n_scored, 'Earth cells scored'], [rp.loaded.length + ' of ' + rp.total, 'datasets loaded (' + rp.notLoaded.length + ' large CSVs left on demand)']]
      .map(function (s) { return '<div class="stat"><b>' + (typeof s[0] === 'number' ? s[0].toLocaleString('en-US') : s[0]) + '</b><span>' + s[1] + '</span></div>'; }).join('');
    var bm = FZ.analysis.candidates.mars.primary[0], bo = FZ.analysis.candidates.moon.primary[0], sc = FZ.analysis.scale_comparison;
    var hi = function (t) { return R[t][120].cells.filter(function (c) { return c.status === 'scored' && c.score >= 80; }).length; };
    var L = [
      'Mean slope at 120 m: Earth ' + f(cmp.earth.slope_deg_mean) + '°, Mars ' + f(cmp.mars.slope_deg_mean) + '°, Moon ' + f(cmp.moon.slope_deg_mean) + '°. Earth\'s site is the flattest of the three.',
      'Best Earth match to Mars: score ' + f(bm.score, 1) + ' at ' + f(bm.lat_deg, 4) + '°N, ' + f(bm.lon_deg, 4) + '°E. Best match to the Moon: score ' + f(bo.score, 1) + ' at ' + f(bo.lat_deg, 4) + '°N, ' + f(bo.lon_deg, 4) + '°E.',
      hi('mars').toLocaleString('en-US') + ' cells score 80 or more against Mars and ' + hi('moon').toLocaleString('en-US') + ' against the Moon (of ' + st.n_scored.toLocaleString('en-US') + ' scored).',
      'Resolution matters: only ' + f(sc.mars.fraction_consistent * 100, 0) + ' % (Mars) and ' + f(sc.moon.fraction_consistent * 100, 0) + ' % (Moon) of cells score consistently at 120 m and 360 m.',
      'Climate evidence is thin: Earth T2M is missing, and Mars and Moon have no climate data.'];
    $('findings').innerHTML = L.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('');
    var warn = rp.warnings.length, rows = [['Loaded', rp.loaded.length + ' of ' + rp.total], ['Failed', rp.failed.length || 'none'], ['Loader warnings', warn || 'none']];
    $('datastatus').innerHTML = '<table>' + rows.map(function (r) { return '<tr><td>' + r[0] + '</td><td>' + r[1] + '</td></tr>'; }).join('') + '</table>' + (rp.failed.length ? '<p class="warn">' + rp.failed.map(function (x) { return esc(x.id + ': ' + x.message); }).join('<br>') + '</p>' : '') + (warn ? '<p class="src">' + esc(rp.warnings.slice(0, 2).map(function (w) { return w.id + ': ' + w.message; }).join(' | ')) + '</p>' : '');
    $('objectives').textContent = 'Mission objectives: (1) find Earth terrain that statistically resembles Jezero Crater and Taurus-Littrow, (2) assemble a diverse portfolio of candidate sites, (3) state plainly what the data cannot yet support. ' + FieldZeroSimilarity.MODEL_LABEL;
  }

  // ---------------------------------------------------------------- II Explorer
  function explorer() {
    if (!FZMap.init(FZ, { onSelect: detail, needEarth: function () { setBody('earth'); } })) return;
    seg('bodyseg', Object.keys(FZMap.BODIES).map(function (b) { return [b, FZMap.BODIES[b]]; }), 'earth', setBody);
    $('layersel').onchange = function () { FZMap.setLayer(this.value); };
    $('candtoggle').onchange = function () { FZMap.toggle('cand', this.checked); }; $('porttoggle').onchange = function () { FZMap.toggle('port', this.checked); };
    setBody('earth');
  }
  function setBody(b) {
    [].forEach.call($('bodyseg').children, function (x) { x.classList.toggle('on', x.dataset.v === b); });
    $('layersel').innerHTML = FZMap.layersFor(b).map(function (l) { return '<option value="' + l[0] + '">' + l[1] + '</option>'; }).join('');
    FZMap.setBody(b, $('layersel').value); if (b === 'earth' && FZ.portfolio) FZMap.showPortfolio(FZ.portfolio.items);
    $('candtoggle').disabled = $('porttoggle').disabled = b !== 'earth';
  }
  function detail(p) {
    FZ.sel = p; var e = p.body === 'earth', pr = p.props, crs = e ? 'WGS84 lon/lat' : 'body-native lon/lat, not WGS84';
    var h = '<h3>' + FZMap.BODIES[p.body] + '</h3><p>' + f(p.lat, 5) + '°, ' + f(p.lon, 5) + '° <span class="src">(' + crs + ')</span></p><table>' +
      '<tr><td>Elevation</td><td>' + f(pr.elevation, 1) + ' m <span class="src">own datum</span></td></tr>' + FN.map(function (k) { return '<tr><td>' + UNITS[k][0] + '</td><td>' + f(pr[k]) + ' ' + UNITS[k][1] + '</td></tr>'; }).join('') + '</table>';
    if (e) ['mars', 'moon'].forEach(function (t) { var s = p.scores[t];
      h += '<h3 style="margin-top:12px">Similarity to ' + TN[t] + '</h3>' + (s ? '<p>Score <b>' + f(s.score, 1) + '</b> (rank ' + s.rank + ' of ' + FZ.analysis.results[t][120].stats.n_scored + ')</p>' + FN.map(function (k) { var x = s.f[k]; return '<div class="fbar"><span>' + UNITS[k][0] + '</span><div><i style="width:' + (x.score || 0) + '%"></i></div><span>' + f(x.score, 0) + '</span></div>'; }).join('') : '<p class="src">Not scored: too many missing features (border cell).</p>'); });
    h += '<p><button class="pin" id="pinbtn">Pin to compare</button></p>'; $('detail').innerHTML = h;
    $('pinbtn').onclick = function () { FZ.pinned = FZ.pinned.filter(function (x) { return !(x.body === p.body && x.i === p.i); }); FZ.pinned.push(p); FZ.pinned = FZ.pinned.slice(-3); pinned(); };
  }
  function pinned() {
    if (!FZ.pinned.length) return;
    var c = FZ.pinned, rows = [['Location', function (p) { return f(p.lat, 3) + ', ' + f(p.lon, 3); }], ['Elevation (m)', function (p) { return f(p.props.elevation, 1); }]]
      .concat(FN.map(function (k) { return [UNITS[k][0] + ' (' + UNITS[k][1] + ')', function (p) { return f(p.props[k]); }]; }))
      .concat([['Score to Mars', function (p) { return p.scores && p.scores.mars ? f(p.scores.mars.score, 1) : 'n/a'; }], ['Score to Moon', function (p) { return p.scores && p.scores.moon ? f(p.scores.moon.score, 1) : 'n/a'; }]]);
    $('pinned').innerHTML = '<h3>Compare pinned cells</h3><table><tr><th></th>' + c.map(function (p, i) { return '<th>' + p.body + ' ' + (i + 1) + '</th>'; }).join('') + '</tr>' +
      rows.map(function (r) { return '<tr><td>' + r[0] + '</td>' + c.map(function (p) { return '<td>' + r[1](p) + '</td>'; }).join('') + '</tr>'; }).join('') + '</table><p class="src">Elevations use each body\'s own vertical datum; do not compare them across bodies.</p>';
  }

  // ---------------------------------------------------------------- III Discovery
  function discovery() {
    seg('tgtseg', [['mars', 'Earth to Mars'], ['moon', 'Earth to Moon']], FZ.target, function (v) { FZ.target = v; candTable(); });
    seg('scaleseg', [[120, '120 m (primary)'], [360, '360 m (sensitivity)']], FZ.scale, function (v) { FZ.scale = +v; candTable(); });
    candTable();
  }
  function candTable() {
    var c = FZ.analysis.candidates[FZ.target][FZ.scale === 120 ? 'primary' : 'sensitivity'];
    $('candtable').innerHTML = '<tr><th>#</th><th>Lat</th><th>Lon</th><th>Score</th><th>Confidence</th><th>' + (FZ.scale === 120 ? '360 m check' : 'Limiting') + '</th></tr>' +
      c.map(function (x, i) { return '<tr class="cl" data-i="' + i + '"><td>' + x.candidate_rank + '</td><td>' + f(x.lat_deg, 4) + '</td><td>' + f(x.lon_deg, 4) + '</td><td>' + f(x.score, 1) + '</td><td>' + x.confidence + '</td><td>' + (FZ.scale === 120 ? (x.scale_check ? x.scale_check.consistency : 'n/a') : x.limiting_feature) + '</td></tr>'; }).join('');
    $('candtable').onclick = function (e) { var tr = e.target.closest('tr.cl'); if (!tr) return; [].forEach.call($('candtable').querySelectorAll('tr'), function (r) { r.classList.toggle('on', r === tr); }); candDetail(c[+tr.dataset.i]); };
    $('canddetail').innerHTML = '<h3>Select a candidate</h3><p>Pick a row to see how each terrain feature contributes.</p>';
  }
  function candDetail(x) {
    $('canddetail').innerHTML = '<h3>Candidate ' + x.candidate_rank + ' · score ' + f(x.score, 1) + '</h3><p>' + f(x.lat_deg, 5) + '°N, ' + f(x.lon_deg, 5) + '°E · ' + x.confidence + ' confidence · limiting feature: ' + x.limiting_feature + '</p>' +
      FN.map(function (k) { var y = x.features[k]; return '<div class="fbar"><span>' + UNITS[k][0] + '</span><div><i style="width:' + y.score + '%"></i></div><span>' + f(y.score, 0) + '</span></div><p class="src" style="margin:0 0 6px">value ' + f(y.value) + ' ' + UNITS[k][1] + ' vs reference median ' + f(y.reference_center) + ' · contributes ' + f(y.contribution, 1) + ' pts</p>'; }).join('') +
      (x.scale_check ? '<p>360 m parent scores ' + f(x.scale_check.score_360m, 1) + ' (' + x.scale_check.consistency + ').</p>' : '') + '<p class="src">' + esc(x.status_label) + '</p>' + (FZ.scale === 120 ? '<button class="pin" id="showmap">Show on map</button>' : '');
    var b = $('showmap'); if (b) b.onclick = function () { document.getElementById('explorer').scrollIntoView(); if (FZMap.body !== 'earth') setBody('earth'); FZMap.focus(x.lon_deg, x.lat_deg); };
  }

  // ---------------------------------------------------------------- V Portfolio
  function portfolioUI() {
    var tgt = 'mars', run = function () {
      var n = +$('pn').value, sep = +$('psep').value; $('pnv').textContent = n; $('psepv').textContent = sep + ' km';
      var p = FZ.portfolio = FieldZeroIntel.portfolio(FZ.analysis, FZ.rows, { target: tgt, n: n, minSepM: sep * 1000 });
      $('pobj').innerHTML = '<b>Objective.</b> ' + esc(p.objective) + '<br><b>Limitations.</b> ' + esc(p.limitations.join(' '));
      $('pitems').innerHTML = p.items.map(function (it) { return '<div class="card gap" data-lon="' + it.lon_deg + '" data-lat="' + it.lat_deg + '"><h3>Site ' + it.pick + ' · score ' + f(it.score, 1) + '</h3><p>' + f(it.lat_deg, 4) + '°N, ' + f(it.lon_deg, 4) + '°E</p>' +
        '<p class="src">' + FN.map(function (k) { return UNITS[k][0] + ' ' + f(it.features[k].value) + ' ' + UNITS[k][1]; }).join(' · ') + '</p><p>' + esc(it.why_selected) + '</p><p class="src">' + esc(it.status_label) + '</p></div>'; }).join('');
      var c = p.comparison_to_top_scores_only;
      $('pcmp').textContent = 'Portfolio: mean score ' + f(c.portfolio_mean_score, 1) + ', mean terrain distance between sites ' + f(c.portfolio_mean_pairwise_terrain_distance) + '. Top ' + p.items.length + ' scores alone: mean score ' + f(c.top_scores_mean_score, 1) + ' but terrain distance only ' + f(c.top_scores_mean_pairwise_terrain_distance) + ' (near-duplicate cells).';
      FZMap.showPortfolio(p.items); brief();
    };
    seg('ptgt', [['mars', 'Mars analog portfolio'], ['moon', 'Moon analog portfolio']], tgt, function (v) { tgt = v; run(); });
    $('pn').oninput = $('psep').oninput = run;
    $('pitems').onclick = function (e) { var c = e.target.closest('.card'); if (c) { document.getElementById('explorer').scrollIntoView(); if (FZMap.body !== 'earth') setBody('earth'); FZMap.focus(+c.dataset.lon, +c.dataset.lat); } };
    run();
  }

  // ---------------------------------------------------------------- VI Evidence
  function evidence() {
    var g = FZ.gaps, cls = function (s) { return 's-' + s.split(' ')[0]; };
    $('gapsum').innerHTML = Object.keys(g.counts).map(function (k) { return '<div class="stat"><b>' + g.counts[k] + '</b><span>' + k + '</span></div>'; }).join('');
    $('gaps').innerHTML = g.items.map(function (x) { return '<div class="card gap"><span class="chip ' + cls(x.status) + '">' + x.status + '</span><h3>' + esc(x.variable) + '</h3><p class="src">Body: ' + esc(x.body) + '</p><p>' + esc(x.why_it_matters) + '</p><dl>' +
      '<dt>Current evidence</dt><dd>' + esc(x.current_evidence) + '</dd><dt>Recommended source</dt><dd>' + esc(x.recommended_source) + ' <i>' + esc(x.source_access) + '</i></dd><dt>Cannot yet conclude</dt><dd>' + esc(x.cannot_conclude) + '</dd></dl></div>'; }).join('');
  }

  // ---------------------------------------------------------------- VII Brief
  var briefMd = '';
  function brief() {
    var p = FZ.portfolio, a = FZ.analysis, md = ['# FIELD//ZERO mission brief', '', '_' + FieldZeroSimilarity.MODEL_LABEL + '_', '', '## Selected locations (' + TN[p.options.target] + ' portfolio, ' + p.items.length + ' sites, min separation ' + p.options.minSepM / 1000 + ' km)'];
    p.items.forEach(function (it) { md.push('- Site ' + it.pick + ': ' + f(it.lat_deg, 4) + 'N, ' + f(it.lon_deg, 4) + 'E, score ' + f(it.score, 1) + '. ' + it.why_selected); });
    md.push('', '## Scientific findings'); [].forEach.call($('findings').children, function (li) { md.push('- ' + li.textContent); });
    md.push('', '## Objective and limits of the portfolio', p.objective, ''); p.limitations.forEach(function (l) { md.push('- ' + l); });
    md.push('', '## Evidence limitations'); FZ.gaps.items.forEach(function (g) { md.push('- ' + g.variable + ' (' + g.body + '): ' + g.status + '. Cannot conclude: ' + g.cannot_conclude); });
    md.push('', '## Disclaimer', FieldZeroSimilarity.DISCLAIMER); briefMd = md.join('\n');
    $('briefbody').innerHTML = md.map(function (l) { return l.indexOf('# ') === 0 ? '<h3>' + esc(l.replace(/^#+ /, '')) + '</h3>' : l.indexOf('- ') === 0 ? '<p>• ' + esc(l.slice(2)) + '</p>' : l ? '<p>' + esc(l.replace(/^_|_$/g, '')) + '</p>' : ''; }).join('');
    $('dlmd').onclick = function () { dl('fieldzero_mission_brief.md', briefMd, 'text/markdown'); };
    $('dljson').onclick = function () { dl('fieldzero_mission_data.json', JSON.stringify({ portfolio: FZ.portfolio, evidence_gaps: FZ.gaps }, null, 1), 'application/json'); };
    $('print').onclick = function () { window.print(); };
  }
  function dl(name, text, type) { var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: type })); a.download = name; a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 500); }

  function nav() {
    var links = [].slice.call(document.querySelectorAll('#rail a[data-ch]'));
    var io = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) links.forEach(function (a) { a.classList.toggle('on', a.dataset.ch === e.target.id); }); }); }, { rootMargin: '-40% 0px -55% 0px' });
    links.forEach(function (a) { io.observe($(a.dataset.ch)); });
  }
  boot();
})();
