/*! FIELD//ZERO mission intelligence v1.0.0 - portfolio optimizer + evidence gap detector.
 *  Pure computation (browser + Node 18+). Reuses FieldZeroSimilarity output; recomputes no scores.
 *  Deterministic: no randomness; ties break on lowest CSV row index. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FieldZeroIntel = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var FEATS = ['slope_deg', 'roughness_std', 'elev_variability_std', 'tri'];
  var DEFAULTS = { target: 'mars', n: 5, minSepM: 2000, poolSize: 3000, minCompleteness: 0.7,
    weights: { score: 0.5, diversity: 0.3, completeness: 0.2 }, diversityRefSD: 1.0 };
  var STATUS = 'Terrain-metric similarity candidate. Not a confirmed analog.';
  var r = function (v, d) { var k = Math.pow(10, d == null ? 2 : d); return Math.round(v * k) / k; };

  // ---------------------------------------------------------------- Module A
  /** analysis = FieldZeroSimilarity.analyze*(...); rows = Earth 120 m CSV rows (same order as analysis cells). */
  function portfolio(analysis, rows, options) {
    var o = Object.assign({}, DEFAULTS, options || {});
    o.weights = Object.assign({}, DEFAULTS.weights, (options || {}).weights || {});
    if (o.target !== 'mars' && o.target !== 'moon') throw new Error('target must be mars or moon');
    o.n = Math.max(1, Math.min(12, Math.round(o.n)));
    var cells = analysis.results[o.target][120].cells;
    if (cells.length !== rows.length) throw new Error('cells/rows length mismatch: ' + cells.length + ' vs ' + rows.length);
    var elig = [];
    for (var i = 0; i < cells.length; i++) {
      var c = cells[i];
      if (c.status === 'scored' && c.score != null && c.completeness >= o.minCompleteness && FEATS.every(function (f) { return c.features[f].value != null; })) elig.push(i);
    }
    elig.sort(function (a, b) { return cells[b].score - cells[a].score || a - b; });
    var pool = elig.slice(0, o.poolSize);
    // terrain space: log1p of each metric, scaled by its SD over ALL eligible cells (not just the pool)
    var L = function (i) { return FEATS.map(function (f) { return Math.log1p(cells[i].features[f].value); }); };
    var sd = FEATS.map(function (_, k) {
      var m = 0, s = 0; elig.forEach(function (i) { m += L(i)[k]; }); m /= elig.length;
      elig.forEach(function (i) { var d = L(i)[k] - m; s += d * d; }); return Math.sqrt(s / elig.length) || 1;
    });
    var V = {}; pool.forEach(function (i) { V[i] = L(i).map(function (v, k) { return v / sd[k]; }); });
    var tdist = function (a, b) { var s = 0; for (var k = 0; k < 4; k++) { var d = V[a][k] - V[b][k]; s += d * d; } return Math.sqrt(s); };
    var mdist = function (a, b) { var dx = rows[a].x_m_localTM - rows[b].x_m_localTM, dy = rows[a].y_m_localTM - rows[b].y_m_localTM; return Math.sqrt(dx * dx + dy * dy); };
    var w = o.weights, sel = [], picks = [];
    while (sel.length < o.n) {
      var best = null;
      for (var p = 0; p < pool.length; p++) {
        var i2 = pool[p], dm = Infinity, dt = Infinity, ok = true;
        for (var s2 = 0; s2 < sel.length; s2++) {
          var md = mdist(i2, sel[s2]); if (md < o.minSepM) { ok = false; break; }
          dm = Math.min(dm, md); dt = Math.min(dt, tdist(i2, sel[s2]));
        }
        if (!ok) continue;
        var div = sel.length ? Math.min(1, dt / o.diversityRefSD) : 1;
        var comp = cells[i2].completeness;
        var gain = w.score * cells[i2].score / 100 + w.diversity * div + w.completeness * comp;
        if (!best || gain > best.gain + 1e-12) best = { i: i2, gain: gain, div: div, dm: dm, dt: dt, comp: comp };
      }
      if (!best) break;
      sel.push(best.i); picks.push(best);
    }
    var items = picks.map(function (b, k) {
      var c = cells[b.i], row = rows[b.i], f = {};
      FEATS.forEach(function (n) { f[n] = { value: c.features[n].value, score: r(c.features[n].score, 1), contribution: r(c.features[n].contribution, 2) }; });
      var lim = c.limiting_feature;
      var why = (k === 0 ? 'Anchor site: highest similarity score in the eligible pool. ' :
        'Added because it keeps a high score (' + r(c.score, 1) + ') while sitting ' + r(b.dm / 1000, 1) + ' km from the nearest selected site with terrain-space distance ' + r(b.dt, 2) + ' (1.0 = one SD of Earth terrain variation), so it adds a different terrain type rather than a neighbour of an earlier pick. ') +
        'Engine cell rank ' + c.rank + ' of ' + analysis.results[o.target][120].stats.n_scored + '; weakest feature: ' + (lim || 'n/a') + '. ' +
        (c.scale ? 'Its 360 m parent cell scores ' + r(c.scale.score_coarse, 1) + ' (' + c.scale.consistency + ' across resolution).' : 'No 360 m cross-check available.');
      return { pick: k + 1, csv_row_index: b.i, lon_deg: row.lon_deg, lat_deg: row.lat_deg, x_m_localTM: row.x_m_localTM, y_m_localTM: row.y_m_localTM,
        score: r(c.score, 2), engine_cell_rank: c.rank, confidence: c.confidence, completeness: c.completeness, features: f,
        elevation_m: row.elevation, nearest_selected_km: isFinite(b.dm) ? r(b.dm / 1000, 2) : null, terrain_distance_to_selected: isFinite(b.dt) ? r(b.dt, 2) : null,
        objective_gain: r(b.gain, 4), scale_consistency: c.scale ? c.scale.consistency : 'n/a', score_360m: c.scale ? r(c.scale.score_coarse, 2) : null,
        why_selected: why, status_label: STATUS };
    });
    var mean = function (a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : null; };
    var pairD = function (ids) { var d = []; for (var a = 0; a < ids.length; a++) for (var b = a + 1; b < ids.length; b++) d.push(tdist(ids[a], ids[b])); return mean(d); };
    var topN = pool.slice(0, o.n);   // naive baseline: top-N scores with no separation or diversity rule
    return {
      options: { target: o.target, n: o.n, minSepM: o.minSepM, poolSize: pool.length, minCompleteness: o.minCompleteness, weights: o.weights, diversityRefSD: o.diversityRefSD },
      objective: 'Greedy maximisation of gain = w_score*score/100 + w_diversity*min(1, d_terrain/refSD) + w_completeness*completeness, subject to a hard minimum separation of ' + o.minSepM + ' m (local transverse-Mercator metres). d_terrain = Euclidean distance to the nearest already-selected site in log1p(slope, roughness, elevation variability, TRI) space scaled by each metric\'s SD over eligible Earth cells.',
      limitations: ['Greedy selection is deterministic but not guaranteed globally optimal.',
        'Only the four DEM-derived terrain metrics are used; geology, composition, regolith, illumination, temperature and gravity are not represented.',
        'Search is limited to the Earth Western Desert window in the processed data and to the top ' + pool.length + ' scored cells.',
        'Weights are expert-judgement defaults, not fitted. Neighbouring cells share smoothing kernels, so 2 km separation does not imply independent terrain.',
        'No selected site is a confirmed planetary analog.'],
      eligible_cells: elig.length, items: items,
      comparison_to_top_scores_only: { portfolio_mean_score: r(mean(items.map(function (x) { return x.score; })), 2), portfolio_mean_pairwise_terrain_distance: items.length > 1 ? r(pairD(sel), 2) : null,
        top_scores_mean_score: r(mean(topN.map(function (i) { return cells[i].score; })), 2), top_scores_mean_pairwise_terrain_distance: topN.length > 1 ? r(pairD(topN), 2) : null,
        note: 'Top-score-only picks are typically adjacent cells (same terrain); the portfolio trades a little score for diversity.' },
      model: analysis.model, status_label: STATUS
    };
  }

  // ---------------------------------------------------------------- Module B
  var NOT_ACCESSED = 'Recommended only. This project did not access this source.';
  /** data = FieldZeroData.data. Statuses are derived from what is actually loaded. */
  function evidenceGaps(data) {
    var cols = (data && data.climate && data.climate.earth && data.climate.earth.daily && data.climate.earth.daily.columns) || [];
    var has = function (c) { return cols.indexOf(c) !== -1; };
    var un = (data && data.unavailable) || [];
    var listed = function (b) { return un.some(function (u) { return u.body === b; }); };
    var hasClimate = function (b) { return !!(data && data.climate && data.climate[b] && data.climate[b].daily); };
    var G = function (id, variable, body, why, status, evidence, source, cannot) {
      return { id: id, variable: variable, body: body, why_it_matters: why, status: status, current_evidence: evidence, recommended_source: source, source_access: NOT_ACCESSED, cannot_conclude: cannot };
    };
    var items = [
      G('earth_t2m', 'T2M (daily mean 2 m air temperature)', 'Earth',
        'Mean temperature anchors thermal-regime comparisons; max/min alone do not give the mean.',
        has('T2M') ? 'Available' : (has('T2M_MAX') || has('T2M_MIN') ? 'Partially available' : 'Missing'),
        'Columns loaded: ' + (cols.join(', ') || 'none') + '. T2M is not in the files; the pipeline reports its download failed. Do not derive it from T2M_MAX/T2M_MIN.',
        'NASA POWER daily point API, parameter T2M (the parameter list in reports/power_parameter_availability.json lists it; it was not downloaded).',
        'Mean daily temperature, diurnal-mean statistics, any thermal analog claim.'),
      G('moon_temperature', 'Verified lunar surface temperature', 'Moon', 'Surface thermal extremes drive mission design for hardware and power.',
        hasClimate('moon') ? 'Not independently verified' : 'Missing', listed('moon') ? 'Manifest lists Moon temperature/solar as unavailable (Diviner not processed).' : 'No Moon climate dataset loaded.',
        'LRO Diviner Lunar Radiometer products (NASA PDS Geosciences Node).', 'Any thermal similarity between Earth cells and Taurus-Littrow.'),
      G('mars_climate', 'Verified Mars climate (temperature, pressure, wind, solar, humidity)', 'Mars', 'Atmosphere controls dust, thermal cycling and entry/operations conditions.',
        hasClimate('mars') ? 'Not independently verified' : 'Missing', listed('mars') ? 'Manifest lists Mars atmosphere as unavailable (MEDA not processed).' : 'No Mars climate dataset loaded.',
        'Mars 2020 MEDA environmental data (NASA PDS Atmospheres Node).', 'Any atmospheric or climate analog claim for Jezero.'),
      G('moon_illumination', 'Lunar illumination / solar geometry', 'Moon', 'Sun angle and shadow set power, thermal and imaging conditions.',
        'Missing', 'No illumination dataset is registered in the site manifest.', 'LOLA-derived illumination products and LRO Camera imagery (NASA PDS / USGS Astrogeology).', 'Lighting, shadowing or power-availability similarity.'),
      G('surface_composition', 'Surface composition (mineralogy / chemistry)', 'Earth, Mars, Moon', 'Composition shapes dust, chemistry and science targets; terrain shape alone does not capture it.',
        'Missing', 'Surface-characteristic layers are not implemented (README, DATASET_INVENTORY).', 'Mars: CRISM and Mars 2020 instrument data (PDS). Moon: LRO/Apollo sample and spectral products (PDS). Earth: geological maps.', 'Whether any Earth cell is geologically similar.'),
      G('regolith_soil', 'Soil / regolith properties (grain size, cohesion, rock abundance)', 'Earth, Mars, Moon', 'Trafficability and excavation depend on soil mechanics.',
        'Missing', 'No soil or regolith layer is in the processed data.', 'Moon: Apollo returned-sample data and Diviner rock abundance. Mars: rover traverse and thermal-inertia products. Earth: soil surveys.', 'Rover mobility or excavation analog claims.'),
      G('vertical_datums', 'Common vertical datum for absolute elevation', 'Earth, Mars, Moon', 'Each body uses its own elevation zero, so absolute elevations are not comparable.',
        'Partially available', 'Elevation exists per body and is used for within-body terrain metrics only; the similarity model excludes it.', 'Body-specific datum documentation (NASADEM, MOLA/CTX, LOLA).', 'Any cross-body comparison of absolute elevation.'),
      G('reference_representativeness', 'Representativeness of one reference site per body', 'Mars, Moon', 'Jezero and Taurus-Littrow are single sites; scores describe closeness to them only.',
        'Not independently verified', 'One reference site per body; no external validation of the scores.', 'Additional reference sites and independent analog studies.', 'That a high-scoring cell resembles Mars or the Moon in general.'),
      G('climate_model_vs_station', 'Station-measured Earth climate', 'Earth', 'POWER values are modelled/satellite-derived for a grid cell, not station measurements.',
        has('T2M_MAX') ? 'Not independently verified' : 'Missing', 'Daily POWER records exist (n=' + ((data && data.climate && data.climate.earth && data.climate.earth.daily && data.climate.earth.daily.rowCount) || 0) + ') for one point.', 'Egyptian meteorological station records.', 'Local measured temperature extremes.')
    ];
    var counts = {}; items.forEach(function (g) { counts[g.status] = (counts[g.status] || 0) + 1; });
    return { note: 'Potential evidence gaps, not measurements. Statuses are derived from the data actually loaded. No source listed here was accessed by this project.', counts: counts, items: items };
  }
  return { version: '1.0.0', FEATURES: FEATS, DEFAULTS: DEFAULTS, portfolio: portfolio, evidenceGaps: evidenceGaps };
});
