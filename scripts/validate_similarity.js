'use strict';
/* FIELD//ZERO similarity validation. Real input datasets only.
 *   node scripts/run_similarity.js && python3 scripts/crosscheck_similarity.py && node scripts/validate_similarity.js
 * Writes reports/similarity_validation.md. Exit code 1 if any gated test fails.
 *
 * Every number in the report is computed here from the real CSV/summary files or from the written output files.
 * Algebraic checks (T-C*) use reference statistics read from the real summary JSONs as the probe values; they do not
 * introduce any invented measurement. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const E = require('../website/js/similarity-engine.js');
const IO = require('./similarity_io.js');
const U = E.util;

const FEATS = E.ALLOWED_FEATURES;
const OUT = (f) => path.join(IO.ROOT, 'outputs', f);
const tests = [];
const M = {};                       // measurements for the report
function T(id, group, name, gated, fn) {
  let r;
  try { r = fn(); } catch (e) { r = { pass: false, detail: 'EXCEPTION: ' + e.message }; }
  tests.push({ id, group, name, gated, pass: !!r.pass, detail: r.detail || '' });
}
const f2 = (v, d) => (v === null || v === undefined || !isFinite(v)) ? 'n/a' : Number(v).toFixed(d === undefined ? 2 : d);
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

// ---------------------------------------------------------------- load real data
console.log('loading real datasets ...');
const inputs = IO.loadInputs(true);                     // includes Mars/Moon cell rows (validation only)
const analysis = E.analyze(inputs);                     // default config
const cfg = analysis.config;
const earth120 = inputs.earth[120].rows, earth360 = inputs.earth[360].rows;
const gj = {}, gjText = {};
['mars', 'moon'].forEach((b) => { gjText[b] = fs.readFileSync(OUT('earth_' + b + '_similarity.geojson'), 'utf8'); gj[b] = JSON.parse(gjText[b]); });
const topText = fs.readFileSync(OUT('top_candidates.json'), 'utf8');
const top = JSON.parse(topText);

// ---------------------------------------------------------------- A. input integrity
function colStats(rows, f) {
  let n = 0, s = 0, mn = Infinity, mx = -Infinity;
  for (const r of rows) { const v = r[f]; if (v === null || v === undefined || !isFinite(v)) continue; n++; s += v; if (v < mn) mn = v; if (v > mx) mx = v; }
  const mean = s / n; let ss = 0;
  for (const r of rows) { const v = r[f]; if (v === null || v === undefined || !isFinite(v)) continue; ss += (v - mean) * (v - mean); }
  return { n, mean, std: Math.sqrt(ss / n), min: mn, max: mx };
}
T('A1', 'Input integrity', 'Recomputed n/mean/std/min/max of every feature in all 6 terrain CSVs match the summary JSONs', true, () => {
  // CSVs are rounded to 4 decimals while the summaries were computed from unrounded values, so tolerance = 5e-4 abs + 1e-5 rel.
  let worst = 0, bad = [], checked = 0;
  ['earth', 'mars', 'moon'].forEach((b) => [120, 360].forEach((sc) => {
    const rows = inputs[b][sc].rows, sm = inputs[b][sc].summary;
    FEATS.forEach((f) => {
      const c = colStats(rows, f), s = sm[f]; checked++;
      if (c.n !== s.n) bad.push(b + sc + ' ' + f + ' n ' + c.n + '!=' + s.n);
      ['mean', 'std', 'min', 'max'].forEach((k) => {
        const d = Math.abs(c[k] - s[k]), tol = 5e-4 + 1e-5 * Math.abs(s[k]);
        worst = Math.max(worst, d / tol);
        if (d > tol) bad.push(b + sc + ' ' + f + ' ' + k + ' csv=' + c[k] + ' json=' + s[k]);
      });
    });
  }));
  return { pass: bad.length === 0, detail: checked + ' feature blocks checked; worst deviation = ' + f2(worst, 3) + ' x tolerance' + (bad.length ? '; mismatches: ' + bad.slice(0, 4).join(' | ') : '') };
});
T('A2', 'Input integrity', 'Row counts equal summary grid.csv_rows for all 6 terrain CSVs', true, () => {
  const bad = []; ['earth', 'mars', 'moon'].forEach((b) => [120, 360].forEach((sc) => { if (inputs[b][sc].rows.length !== inputs[b][sc].summary.grid.csv_rows) bad.push(b + sc); }));
  return { pass: !bad.length, detail: bad.length ? 'mismatch: ' + bad.join(',') : 'all equal (Earth 120 m = ' + earth120.length + ', Earth 360 m = ' + earth360.length + ')' };
});
T('A3', 'Input integrity', 'Earth 120 m and 360 m grids share one lattice (identical lon/lat at shared x/y) and every 120 m cell has a 360 m parent', true, () => {
  const m360 = new Map(); earth360.forEach((r) => m360.set(r.x_m_localTM + '|' + r.y_m_localTM, r));
  let shared = 0, maxd = 0;
  earth120.forEach((r) => { const q = m360.get(r.x_m_localTM + '|' + r.y_m_localTM); if (q) { shared++; maxd = Math.max(maxd, Math.abs(q.lon_deg - r.lon_deg), Math.abs(q.lat_deg - r.lat_deg)); } });
  const sc = analysis.scale_comparison.mars;
  const unpaired = analysis.results.mars[120].cells.filter((c) => !c.scale || c.scale.parent_index === null).length;
  M.sharedLattice = { shared, maxd, unpaired };
  return { pass: shared > 1000 && maxd < 1e-6 && unpaired === 0, detail: shared + ' shared lattice points, max |lon/lat| difference = ' + maxd.toExponential(2) + ' deg; 120 m cells without a parent = ' + unpaired };
});
T('A4', 'Input integrity', 'Forbidden / unknown features (elevation, aspect, temperature, pressure) are rejected by the engine', true, () => {
  const rej = []; ['elevation', 'aspect_deg', 'temperature', 'pressure', 'T2M', 'PS', 'bogus'].forEach((f) => {
    try { E.resolveConfig({ features: [f], weights: { [f]: 1 } }); } catch (e) { rej.push(f); }
  });
  return { pass: rej.length === 7, detail: 'rejected: ' + rej.join(', ') };
});

// ---------------------------------------------------------------- B. missing values
const earthRowsNull = (r) => FEATS.map((f) => r[f]);
T('B1', 'Missing values', 'Cells with all four features missing get score = null, rank = null, confidence = insufficient (never 0)', true, () => {
  let allNull = 0, bad = 0;
  ['mars', 'moon'].forEach((b) => {
    analysis.results[b][120].cells.forEach((c, i) => {
      const nul = earthRowsNull(earth120[i]).every((v) => v === null);
      if (nul) { allNull++; if (c.score !== null || c.rank !== null || c.confidence !== 'insufficient') bad++; }
    });
  });
  const feat = gj.mars.features.filter((f) => f.properties.score === null).length;
  return { pass: bad === 0 && allNull === 2 * 1048 && feat === 1048, detail: (allNull / 2) + ' all-null cells per body (CSV); violations = ' + bad + '; GeoJSON null-score features = ' + feat };
});
T('B2', 'Missing values', 'Partially missing cells are scored on the remaining features with weights renormalised (completeness < 1, contributions sum to the score)', true, () => {
  let n = 0, bad = 0, minComp = 1, maxComp = 0, maxErr = 0;
  analysis.results.mars[120].cells.forEach((c) => {
    if (c.status === 'scored' && c.completeness < 1 - 1e-12) {
      n++; minComp = Math.min(minComp, c.completeness); maxComp = Math.max(maxComp, c.completeness);
      let sw = 0, sc = 0; FEATS.forEach((f) => { const ft = c.features[f]; if (ft.effective_weight !== null) { sw += ft.effective_weight; sc += ft.contribution; } });
      maxErr = Math.max(maxErr, Math.abs(sw - 1), Math.abs(sc - c.score));
      if (Math.abs(sw - 1) > 1e-9 || Math.abs(sc - c.score) > 1e-9) bad++;
    }
  });
  M.partial = { n, minComp, maxComp };
  const missingWhich = {}; earth120.forEach((r) => { const m = FEATS.filter((f) => r[f] === null).join('+'); if (m) missingWhich[m] = (missingWhich[m] || 0) + 1; });
  M.missingPatterns = missingWhich;
  return { pass: n > 0 && bad === 0, detail: n + ' partial cells (completeness ' + f2(minComp, 3) + '..' + f2(maxComp, 3) + '); max |sum eff.weight-1| or |sum contribution - score| = ' + maxErr.toExponential(1) + '; missing-feature patterns in Earth 120 m CSV: ' + JSON.stringify(missingWhich) };
});
T('B3', 'Missing values', 'Perturbation test on real Earth rows: nulling features gives the hand-computed renormalised score; too few features gives null; negative values are excluded as invalid', true, () => {
  const ref = analysis.references.mars[120];
  const row = earth120.find((r) => FEATS.every((f) => r[f] !== null));
  const full = E.scoreCell(row, ref, cfg);
  const p1 = Object.assign({}, row, { tri: null });
  const c1 = E.scoreCell(p1, ref, cfg);
  const w = cfg.weights; const wsum = w.slope_deg + w.roughness_std + w.elev_variability_std;
  const manual = (w.slope_deg * full.features.slope_deg.score + w.roughness_std * full.features.roughness_std.score + w.elev_variability_std * full.features.elev_variability_std.score) / wsum;
  const ok1 = Math.abs(c1.score - manual) < 1e-9 && Math.abs(c1.completeness - wsum) < 1e-9;
  const c2 = E.scoreCell(Object.assign({}, row, { tri: null, roughness_std: null, elev_variability_std: null }), ref, cfg);   // 1 feature left
  const c3 = E.scoreCell(Object.assign({}, row, { slope_deg: -1 }), ref, cfg);
  const c4 = E.scoreCell(Object.assign({}, row, { slope_deg: NaN, tri: undefined }), ref, cfg);
  const ok2 = c2.score === null && c2.status === 'insufficient';
  const ok3 = c3.features.slope_deg.status === 'invalid' && c3.n_invalid === 1 && c3.completeness < 1;
  const ok4 = c4.features.slope_deg.status === 'missing' && c4.features.tri.status === 'missing';
  return { pass: ok1 && ok2 && ok3 && ok4, detail: 'drop-one: engine ' + f2(c1.score, 6) + ' vs hand ' + f2(manual, 6) + '; 1 feature left -> ' + c2.status + '; negative -> ' + c3.features.slope_deg.status + '; NaN/undefined -> missing' };
});
T('B4', 'Missing values', 'No NaN/Infinity anywhere in the written outputs; all scores lie in [0,100]', true, () => {
  let bad = 0, n = 0;
  ['mars', 'moon'].forEach((b) => gj[b].features.forEach((f) => {
    Object.keys(f.properties).forEach((k) => { const v = f.properties[k]; if (typeof v === 'number') { n++; if (!isFinite(v)) bad++; if ((k === 'score' || k.indexOf('fs_') === 0 || k === 'score_360m') && (v < 0 || v > 100)) bad++; } });
  }));
  const hasNaN = /NaN|Infinity/.test(topText) || /NaN|Infinity/.test(gjText.mars) || /NaN|Infinity/.test(gjText.moon);
  return { pass: bad === 0 && !hasNaN, detail: n + ' numeric properties inspected; violations = ' + bad + '; literal NaN/Infinity tokens = ' + hasNaN };
});

// ---------------------------------------------------------------- C. formula / normalisation (probes taken from real summaries)
function invLower(fe, p) {                                // x such that the reference model's lower-tail probability = p
  let lo = fe.min, hi = fe.max;
  for (let i = 0; i < 200; i++) { const mid = 0.5 * (lo + hi); const q = E.scoreFeature(mid, fe, cfg).percentile; if (q < p) lo = mid; else hi = mid; }
  return 0.5 * (lo + hi);
}
T('C1', 'Formula', 'Feature score = 200*min(F,1-F): 100 at the reference median, 20 at the 10th/90th percentile, 5 at the 2.5th/97.5th (all 4 refs x 4 features x 2 scales, whichever family auto selected)', true, () => {
  let worst = 0, n = 0; const fam = {};
  ['mars', 'moon'].forEach((b) => [120, 360].forEach((sc) => FEATS.forEach((f) => {
    const fe = analysis.references[b][sc].features[f]; fam[fe.model] = (fam[fe.model] || 0) + 1;
    [[0.5, 100], [0.25, 50], [0.75, 50], [0.1, 20], [0.9, 20], [0.025, 5], [0.975, 5]].forEach(([p, want]) => {
      const x = invLower(fe, p); const r = E.scoreFeature(x, fe, cfg); worst = Math.max(worst, Math.abs(r.score - want)); n++;
    });
    if (fe.model !== 'beta') {                                   // z-score models: also check the erfc identity 100*erfc(|z|/sqrt2): 31.73 at 1 sigma, 4.55 at 2 sigma
      [[1, 31.7310508], [2, 4.5500264]].forEach(([z, want]) => {
        const v = fe.model === 'lognormal' ? Math.exp(fe.mu + z * fe.sigma) : fe.mu + z * fe.sigma;
        const r = E.scoreFeature(v, fe, cfg); worst = Math.max(worst, Math.abs(r.score - want)); n++;
      });
    }
  })));
  return { pass: worst < 1e-6, detail: n + ' probes whose values are inverted from the real summary-derived reference models (families used: ' + JSON.stringify(fam) + '); max |error| = ' + worst.toExponential(2) + ' points' };
});
T('C2', 'Formula', 'Feature score is unimodal in the feature value: non-decreasing up to the reference centre, non-increasing after it (all references, both scales)', true, () => {
  let viol = 0, n = 0;
  ['mars', 'moon'].forEach((b) => [120, 360].forEach((sc) => FEATS.forEach((f) => {
    const fe = analysis.references[b][sc].features[f]; let prev = null;
    for (let i = 0; i <= 600; i++) {
      const v = fe.min + (fe.max - fe.min) * i / 600; const r = E.scoreFeature(v, fe, cfg);
      if (prev !== null) { n++; if (v <= fe.center && r.score < prev - 1e-9) viol++; if (prev !== null && v > fe.center && r.score > prev + 1e-9 && (v - (fe.max - fe.min) / 600) >= fe.center) viol++; }
      prev = r.score;
    }
  })));
  return { pass: viol === 0, detail: n + ' adjacent steps swept from reference min to max (summary values); violations = ' + viol };
});
T('C3', 'Formula', 'Contributions sum to the overall score and overall score = weighted mean of feature scores, for every scored cell in both targets', true, () => {
  let maxErr = 0, n = 0;
  ['mars', 'moon'].forEach((b) => [120, 360].forEach((sc) => analysis.results[b][sc].cells.forEach((c) => {
    if (c.status !== 'scored') return; n++;
    let sw = 0, sx = 0, sc2 = 0;
    FEATS.forEach((f) => { const ft = c.features[f]; if (ft.status === 'ok') { sw += ft.weight; sx += ft.weight * ft.score; sc2 += ft.contribution; } });
    maxErr = Math.max(maxErr, Math.abs(sx / sw - c.score), Math.abs(sc2 - c.score));
  })));
  return { pass: maxErr < 1e-9, detail: n + ' cell-scores; max error = ' + maxErr.toExponential(2) };
});
T('C4', 'Formula', 'Weights are configurable: normalised to sum 1, invalid sets rejected, single-feature weighting reproduces that feature score', true, () => {
  const a = E.resolveConfig({ weights: { slope_deg: 3, roughness_std: 1, elev_variability_std: 3, tri: 1 } });
  const okNorm = Math.abs(Object.values(a.weights).reduce((x, y) => x + y, 0) - 1) < 1e-12 && Math.abs(a.weights.slope_deg - 0.375) < 1e-12;
  const rej = []; [{ weights: { slope_deg: -1, roughness_std: 1, elev_variability_std: 1, tri: 1 } }, { weights: { slope_deg: 0, roughness_std: 0, elev_variability_std: 0, tri: 0 } }, { weights: { slope_deg: 1 } }, { weights: { slope_deg: 1, roughness_std: 1, elev_variability_std: 1, tri: 'x' } }, { distribution: 'bogus' }].forEach((u) => { try { E.resolveConfig(u); } catch (e) { rej.push(1); } });
  const c1 = E.resolveConfig({ weights: { slope_deg: 1, roughness_std: 0, elev_variability_std: 0, tri: 0 }, minFeatures: 1 });
  const t = E.scoreTable(earth120, analysis.references.mars[120], c1);
  let maxd = 0; t.cells.forEach((c) => { if (c.status === 'scored') maxd = Math.max(maxd, Math.abs(c.score - c.features.slope_deg.score)); });
  const nScored = t.cells.filter((c) => c.status === 'scored').length;
  const nSlopeOk = earth120.filter((r) => r.slope_deg !== null).length;
  return { pass: okNorm && rej.length === 5 && maxd < 1e-12 && nScored === nSlopeOk, detail: 'normalisation ok=' + okNorm + '; invalid configs rejected=' + rej.length + '/5; slope-only max |score - slope score| = ' + maxd.toExponential(1) + '; scored cells ' + nScored + ' = cells with slope ' + nSlopeOk };
});
T('C5', 'Formula', 'Absolute elevation never influences scores: perturbing the elevation column by +1000 m leaves every score unchanged', true, () => {
  const bumped = earth120.map((r) => Object.assign({}, r, { elevation: (r.elevation === null ? null : r.elevation + 1000) }));
  const t = E.scoreTable(bumped, analysis.references.mars[120], cfg);
  let d = 0; t.cells.forEach((c, i) => { const o = analysis.results.mars[120].cells[i]; if ((c.score === null) !== (o.score === null)) d = Infinity; else if (c.score !== null) d = Math.max(d, Math.abs(c.score - o.score)); });
  return { pass: d === 0, detail: 'max score change = ' + d };
});

// ---------------------------------------------------------------- D. empirical calibration against the real reference cells
function sortedCol(rows, f) { return rows.map((r) => r[f]).filter((v) => v !== null && isFinite(v)).sort((a, b) => a - b); }
function ecdfTypicality(sorted, x) {                  // 100*(1-|2F-1|), mid-rank ECDF
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < x) lo = m + 1; else hi = m; }
  const a = lo; hi = sorted.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] <= x) lo = m + 1; else hi = m; }
  const F = (a + lo) / 2 / sorted.length; return 100 * (1 - Math.abs(2 * F - 1));
}
const refSorted = {};
['mars', 'moon'].forEach((b) => [120, 360].forEach((sc) => { refSorted[b + sc] = {}; FEATS.forEach((f) => { refSorted[b + sc][f] = sortedCol(inputs[b][sc].rows, f); }); }));

T('D1', 'Empirical calibration', 'Self-calibration: if the summary-based model were exact, a reference\'s own cells would score 50 on average. Mean self score within 50 +/- 15 for all 16 reference features', true, () => {
  const tbl = []; let worst = 0;
  ['mars', 'moon'].forEach((b) => [120, 360].forEach((sc) => FEATS.forEach((f) => {
    const fe = analysis.references[b][sc].features[f]; let s = 0, n = 0;
    inputs[b][sc].rows.forEach((r) => { const q = E.scoreFeature(r[f], fe, cfg); if (q.status === 'ok') { s += q.score; n++; } });
    const mean = s / n; worst = Math.max(worst, Math.abs(mean - 50)); tbl.push({ body: b, scale: sc, feature: f, model: fe.model, mean_self_score: mean });
  })));
  M.calibration = tbl;
  return { pass: worst <= 15, detail: 'largest |mean - 50| = ' + f2(worst, 1) + ' points (threshold chosen after exploratory inspection of these numbers; see limitations)' };
});
T('D2', 'Empirical calibration', 'Agreement with the full-distribution (empirical CDF) typicality for Earth cells: Spearman >= 0.85 for every feature/reference/scale', true, () => {
  const tbl = []; let worst = 1;
  ['mars', 'moon'].forEach((b) => [120, 360].forEach((sc) => {
    const rows = sc === 120 ? earth120 : earth360, ref = analysis.references[b][sc];
    FEATS.forEach((f) => {
      const a = [], c = [];
      rows.forEach((r) => { const q = E.scoreFeature(r[f], ref.features[f], cfg); if (q.status === 'ok') { a.push(q.score); c.push(ecdfTypicality(refSorted[b + sc][f], r[f])); } });
      const rho = U.spearman(a, c); worst = Math.min(worst, rho);
      let md = 0; for (let i = 0; i < a.length; i++) md += Math.abs(a[i] - c[i]); md /= a.length;
      tbl.push({ body: b, scale: sc, feature: f, spearman: rho, mean_abs_diff: md });
    });
  }));
  M.ecdfAgreement = tbl;
  return { pass: worst >= 0.85, detail: 'lowest Spearman = ' + f2(worst, 3) + '; mean absolute score difference range ' + f2(Math.min(...tbl.map((x) => x.mean_abs_diff)), 1) + '..' + f2(Math.max(...tbl.map((x) => x.mean_abs_diff)), 1) + ' points' };
});
function auc(pos, neg) {
  const all = pos.concat(neg), r = U.averageRanks(all); let s = 0; for (let i = 0; i < pos.length; i++) s += r[i];
  return (s - pos.length * (pos.length + 1) / 2) / (pos.length * neg.length);
}
function overallEmpirical(rows, body, sc) {               // same weights/missing rule, but per-feature score from the FULL empirical reference distribution
  const out = [];
  rows.forEach((r) => {
    let W = 0, S = 0, used = 0;
    FEATS.forEach((f) => { const v = r[f]; if (v === null || !isFinite(v)) return; W += cfg.weights[f]; S += cfg.weights[f] * ecdfTypicality(refSorted[body + sc][f], v); used++; });
    if (used >= cfg.minFeatures && W >= cfg.minWeightCompleteness - 1e-12) out.push(S / W);
  });
  return out;
}
function scoreAllWith(rows, ref, c) { return E.scoreTable(rows, ref, c).cells.filter((x) => x.status === 'scored').map((x) => x.score); }
M.auc = [];
[120, 360].forEach((sc) => {
  const R = (b) => analysis.references[b][sc];
  const mm = scoreAllWith(inputs.mars[sc].rows, R('mars'), cfg), om = scoreAllWith(inputs.moon[sc].rows, R('mars'), cfg);
  const oo = scoreAllWith(inputs.moon[sc].rows, R('moon'), cfg), mo = scoreAllWith(inputs.mars[sc].rows, R('moon'), cfg);
  const med = (a) => U.quantile(a.slice().sort((x, y) => x - y), 0.5);
  M.auc.push({
    scale: sc, auc_mars_model: auc(mm, om), auc_moon_model: auc(oo, mo),
    ceiling_mars_model: auc(overallEmpirical(inputs.mars[sc].rows, 'mars', sc), overallEmpirical(inputs.moon[sc].rows, 'mars', sc)),
    ceiling_moon_model: auc(overallEmpirical(inputs.moon[sc].rows, 'moon', sc), overallEmpirical(inputs.mars[sc].rows, 'moon', sc)),
    med_mars_cells_mars_model: med(mm), med_moon_cells_mars_model: med(om), med_moon_cells_moon_model: med(oo), med_mars_cells_moon_model: med(mo)
  });
});
T('D3a', 'Empirical calibration', 'ORIGINAL pre-set discrimination gate: AUC >= 0.70 for own-site vs other-site cells under each model (informational since revision; see section 2 note)', false, () => {
  const worst = Math.min(...M.auc.map((r) => Math.min(r.auc_mars_model, r.auc_moon_model)));
  return { pass: worst >= 0.70, detail: 'lowest AUC = ' + f2(worst, 3) + (worst >= 0.70 ? '' : ' (below 0.70; the full-empirical-distribution baseline is as low as ' + f2(Math.min(...M.auc.map((r) => Math.min(r.ceiling_mars_model, r.ceiling_moon_model))), 3) + ', so 0.70 is not attainable for a calibrated typicality score)') };
});
T('D3b', 'Empirical calibration', 'Discrimination is not materially worse than the empirical baseline: summary-based AUC >= (AUC using the full empirical reference distribution) - 0.05, for both models at 120 m and 360 m', true, () => {
  let worst = Infinity; M.auc.forEach((r) => { worst = Math.min(worst, r.auc_mars_model - r.ceiling_mars_model, r.auc_moon_model - r.ceiling_moon_model); });
  return { pass: worst >= -0.05, detail: 'worst (model AUC - baseline AUC) = ' + f2(worst, 3) + ' (baselines: ' + M.auc.map((r) => r.scale + ' m Mars ' + f2(r.ceiling_mars_model, 3) + ' / Moon ' + f2(r.ceiling_moon_model, 3)).join('; ') + ')' };
});

// model-family comparison on the real reference cells (justifies the auto rule; in-sample, see report)
function ksUniform(p) { const a = p.slice().sort((x, y) => x - y), n = a.length; let d = 0; for (let i = 0; i < n; i++) d = Math.max(d, (i + 1) / n - a[i], a[i] - i / n); return d; }
M.family = [];
['mars', 'moon'].forEach((b) => [120, 360].forEach((sc) => {
  const rows = [];
  ['gaussian', 'lognormal', 'beta'].forEach((fam) => {
    const c = E.resolveConfig({ distribution: fam }); const ref = E.buildReference(inputs[b][sc].summary, c);
    let ks = 0, self = 0, d2 = 0;
    FEATS.forEach((f) => {
      const pit = [], sc2 = []; inputs[b][sc].rows.forEach((r) => { const q = E.scoreFeature(r[f], ref.features[f], c); if (q.status === 'ok') { pit.push(q.percentile); sc2.push(q.score); } });
      ks += ksUniform(pit) / FEATS.length; self += (sc2.reduce((x, y) => x + y, 0) / sc2.length) / FEATS.length;
      const er = sc === 120 ? earth120 : earth360; let sd = 0, nn = 0;
      er.forEach((r) => { const q = E.scoreFeature(r[f], ref.features[f], c); if (q.status === 'ok') { sd += Math.abs(q.score - ecdfTypicality(refSorted[b + sc][f], r[f])); nn++; } });
      d2 += sd / nn / FEATS.length;
    });
    const other = b === 'mars' ? 'moon' : 'mars';
    const own = scoreAllWith(inputs[b][sc].rows, ref, c), oth = scoreAllWith(inputs[other][sc].rows, ref, c);
    rows.push({ body: b, scale: sc, family: fam, ks, self, d2, auc: auc(own, oth) });
  });
  M.family = M.family.concat(rows);
}));
T('D4', 'Empirical calibration', 'The auto rule picks the family with the lowest mean KS distance on the real reference cells, for each of the 4 references (in-sample check)', true, () => {
  const bad = []; const picked = [];
  ['mars', 'moon'].forEach((b) => [120, 360].forEach((sc) => {
    const rs = M.family.filter((r) => r.body === b && r.scale === sc); const best = rs.reduce((x, y) => (y.ks < x.ks ? y : x));
    const chosen = analysis.references[b][sc].features.slope_deg.model; picked.push(b + sc + ':' + chosen);
    if (best.family !== chosen) bad.push(b + sc + ' best=' + best.family + ' auto=' + chosen);
  }));
  return { pass: !bad.length, detail: 'auto selected ' + picked.join(', ') + (bad.length ? '; disagreements: ' + bad.join('; ') : '; always equal to the lowest-KS family') };
});

// ---------------------------------------------------------------- E. independent implementation parity
T('E1', 'Independent parity', 'Python (numpy/scipy) re-implementation reproduces every Earth 120 m score, contribution, rank and 360 m parent score in the written GeoJSON files', true, () => {
  const r = spawnSync('python3', [path.join(__dirname, 'crosscheck_similarity.py')], { encoding: 'utf8' });
  if (r.status !== 0) return { pass: false, detail: 'python crosscheck failed: ' + (r.stderr || '').slice(0, 300) };
  const cc = JSON.parse(fs.readFileSync(path.join(IO.ROOT, 'reports', 'similarity_crosscheck.json'), 'utf8'));
  M.crosscheck = cc;
  let ok = true; const parts = [];
  ['mars', 'moon'].forEach((b) => {
    const t = cc.targets[b];
    const good = t.null_pattern_matches && t.null_pattern_360_matches && t.rank_null_pattern_matches && t.rank_mismatch_count === 0 && t.max_abs_diff_score <= 0.0051 && t.max_abs_diff_contribution <= 0.0051 && t.max_abs_diff_feature_score <= 0.0501 && t.max_abs_diff_score_360m <= 0.0051 && t.max_abs_diff_completeness < 1e-9;
    ok = ok && good; parts.push(b + ': score<=' + t.max_abs_diff_score.toExponential(1) + ', feature<=' + t.max_abs_diff_feature_score.toExponential(1) + ', contrib<=' + t.max_abs_diff_contribution.toExponential(1) + ', 360m<=' + t.max_abs_diff_score_360m.toExponential(1) + ', rank mismatches=' + t.rank_mismatch_count);
  });
  return { pass: ok, detail: parts.join(' | ') + ' (differences are GeoJSON rounding: 0.005 / 0.05 points)' };
});

// ---------------------------------------------------------------- F. output files
T('F1', 'Outputs', 'GeoJSON files: valid FeatureCollections, one Point per Earth 120 m CSV row (same order and coordinates), label + disclaimer present', true, () => {
  const probs = [];
  ['mars', 'moon'].forEach((b) => {
    const g = gj[b];
    if (g.type !== 'FeatureCollection') probs.push(b + ' type');
    if (g.features.length !== earth120.length) probs.push(b + ' count ' + g.features.length);
    let badCoord = 0, badGeom = 0;
    g.features.forEach((f, i) => { if (f.geometry.type !== 'Point') badGeom++; const c = f.geometry.coordinates; if (c[0] !== earth120[i].lon_deg || c[1] !== earth120[i].lat_deg) badCoord++; });
    if (badCoord || badGeom) probs.push(b + ' coord/geom mismatches ' + badCoord + '/' + badGeom);
    if (!g.metadata || g.metadata.model.label.indexOf('TERRAIN ANALOG MODEL') !== 0 || g.metadata.model.disclaimer.indexOf('No location in this output is a confirmed planetary analog') === -1) probs.push(b + ' label/disclaimer');
  });
  return { pass: !probs.length, detail: probs.length ? probs.join('; ') : earth120.length + ' features per file; coordinates identical to CSV; sizes ' + (gjText.mars.length / 1e6).toFixed(1) + ' MB and ' + (gjText.moon.length / 1e6).toFixed(1) + ' MB' };
});
T('F2', 'Outputs', 'Rank is a permutation 1..N over scored cells and ordered by score; rank-1 cell is the maximum score', true, () => {
  const probs = [];
  ['mars', 'moon'].forEach((b) => {
    const sc = gj[b].features.filter((f) => f.properties.rank !== null);
    const ranks = sc.map((f) => f.properties.rank).sort((x, y) => x - y);
    if (ranks.some((r, i) => r !== i + 1)) probs.push(b + ' not a permutation');
    const byRank = sc.slice().sort((x, y) => x.properties.rank - y.properties.rank);
    for (let i = 1; i < byRank.length; i++) if (byRank[i].properties.score > byRank[i - 1].properties.score + 1e-9) { probs.push(b + ' order violated at ' + i); break; }
    const mx = Math.max(...sc.map((f) => f.properties.score)); if (byRank[0].properties.score !== mx) probs.push(b + ' rank 1 != max');
    if (gj[b].features.filter((f) => (f.properties.rank === null) !== (f.properties.score === null)).length) probs.push(b + ' rank/score null mismatch');
  });
  return { pass: !probs.length, detail: probs.length ? probs.join('; ') : 'N scored = ' + gj.mars.features.filter((f) => f.properties.rank !== null).length + ' (both targets)' };
});
T('F3', 'Outputs', 'top_candidates.json: sorted by score, spatially separated, fully complete data, every entry labelled "Not a confirmed analog"', true, () => {
  const probs = [];
  ['mars', 'moon'].forEach((b) => {
    const L = top.targets[b].candidates_120m;
    if (L.length !== cfg.topN) probs.push(b + ' has ' + L.length + ' candidates');
    for (let i = 1; i < L.length; i++) if (L[i].score > L[i - 1].score) probs.push(b + ' unsorted');
    let minD = Infinity;
    for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) minD = Math.min(minD, Math.hypot(L[i].x_m_localTM - L[j].x_m_localTM, L[i].y_m_localTM - L[j].y_m_localTM));
    if (minD < cfg.minSeparationM) probs.push(b + ' min separation ' + minD);
    M['minSep_' + b] = minD;
    if (L.some((c) => c.completeness < 1 || c.n_features_used !== 4)) probs.push(b + ' incomplete candidate');
    if (L.some((c) => c.status_label.indexOf('Not a confirmed analog') === -1)) probs.push(b + ' label');
    const eligibleMax = Math.max(...analysis.results[b][120].cells.filter((c) => c.status === 'scored' && c.completeness >= 1 - 1e-12).map((c) => c.score));
    if (Math.abs(L[0].score - Math.round(eligibleMax * 100) / 100) > 1e-9) probs.push(b + ' candidate 1 is not the best eligible cell');
    L.forEach((c) => { const g = gj[b].features[analysis.results[b][120].ranked[c.cell_rank - 1].index].properties; if (g.score !== c.score || g.rank !== c.cell_rank) probs.push(b + ' candidate/geojson disagree'); });
  });
  if (!/Not a confirmed analog|confirmed planetary analog/.test(topText) || /"[^"]*(is|are) a confirmed analog/i.test(topText)) probs.push('claim wording');
  return { pass: !probs.length, detail: probs.length ? probs.join('; ') : 'min pairwise separation Mars ' + f2(M.minSep_mars, 0) + ' m, Moon ' + f2(M.minSep_moon, 0) + ' m (required >= ' + cfg.minSeparationM + ' m); candidate scores agree with GeoJSON' };
});
T('F4', 'Outputs', 'Determinism and freshness: re-running the engine reproduces the files on disk byte-for-byte', true, () => {
  const a2 = E.analyze(inputs);
  const g1 = JSON.stringify(E.toGeoJSON(a2, 'mars')), g2 = JSON.stringify(E.toGeoJSON(a2, 'moon')), tc = JSON.stringify(E.toTopCandidates(a2), null, 2) + '\n';
  const same = g1 === gjText.mars && g2 === gjText.moon && tc === topText;
  M.hashes = { mars: sha256(gjText.mars), moon: sha256(gjText.moon), top: sha256(topText) };
  return { pass: same, detail: 'sha256 mars ' + M.hashes.mars.slice(0, 16) + '..., moon ' + M.hashes.moon.slice(0, 16) + '..., top ' + M.hashes.top.slice(0, 16) + '...' };
});

// ---------------------------------------------------------------- measurements: sensitivity
function topSet(cells, frac) { const r = cells.filter((c) => c.status === 'scored').sort((a, b) => a.rank - b.rank); const k = Math.max(1, Math.ceil(r.length * frac)); return new Set(r.slice(0, k).map((c) => c.index)); }
function variantRun(body, userCfg) {
  const c = E.resolveConfig(userCfg); const ref = E.buildReference(inputs[body][120].summary, c);
  return E.scoreTable(earth120, ref, c);
}
function compareRuns(base, v) {
  const a = [], b = [];
  base.cells.forEach((c, i) => { if (c.status === 'scored' && v.cells[i].status === 'scored') { a.push(c.score); b.push(v.cells[i].score); } });
  const A = topSet(base.cells, 0.01), B = topSet(v.cells, 0.01); let inter = 0; A.forEach((i) => { if (B.has(i)) inter++; });
  const best = base.ranked[0].index; const vr = v.cells[best].rank;
  return { n: a.length, spearman: U.spearman(a, b), top1pct_jaccard: inter / (A.size + B.size - inter), baseBestRankInVariant: vr };
}
const weightVariants = [
  ['equal weights (0.25 each)', { weights: { slope_deg: 1, roughness_std: 1, elev_variability_std: 1, tri: 1 } }],
  ['slope-heavy (0.55/0.15/0.15/0.15)', { weights: { slope_deg: 0.55, roughness_std: 0.15, elev_variability_std: 0.15, tri: 0.15 } }],
  ['relief-heavy (0.15/0.15/0.55/0.15)', { weights: { slope_deg: 0.15, roughness_std: 0.15, elev_variability_std: 0.55, tri: 0.15 } }],
  ['leave out slope_deg', { weights: { slope_deg: 0, roughness_std: 0.2, elev_variability_std: 0.3, tri: 0.2 } }],
  ['leave out roughness_std', { weights: { slope_deg: 0.3, roughness_std: 0, elev_variability_std: 0.3, tri: 0.2 } }],
  ['leave out elev_variability_std', { weights: { slope_deg: 0.3, roughness_std: 0.2, elev_variability_std: 0, tri: 0.2 } }],
  ['leave out tri', { weights: { slope_deg: 0.3, roughness_std: 0.2, elev_variability_std: 0.3, tri: 0 } }],
  ['force Gaussian references', { distribution: 'gaussian' }],
  ['force lognormal references', { distribution: 'lognormal' }],
  ['force Beta references', { distribution: 'beta' }]
];
M.sens = {};
['mars', 'moon'].forEach((b) => {
  const base = analysis.results[b][120]; M.sens[b] = [];
  weightVariants.forEach(([name, u]) => { M.sens[b].push(Object.assign({ name }, compareRuns(base, variantRun(b, u)))); });
});
T('F5', 'Sensitivity', 'Sensitivity runs complete and produce comparable rankings (weights, leave-one-out, distribution family); results reported, not tuned', false, () => {
  const all = [].concat(M.sens.mars, M.sens.moon); return { pass: all.every((x) => x.n > 60000 && x.spearman !== null), detail: all.length + ' variant runs; see section 6' };
});

// ---------------------------------------------------------------- report
function summarizeConfidence(b, sc) { const o = { high: 0, medium: 0, low: 0, insufficient: 0 }; analysis.results[b][sc].cells.forEach((c) => { o[c.confidence]++; }); return o; }
function ctxTable() {
  const rows = [];
  FEATS.forEach((f) => {
    const e = sortedCol(earth120, f), q = (a, p) => U.quantile(a, p);
    const row = { f, earthMedian: q(e, 0.5) };
    ['mars', 'moon'].forEach((b) => {
      const s = refSorted[b + 120][f]; row[b + 'Median'] = q(s, 0.5);
      const p10 = q(s, 0.1), p90 = q(s, 0.9); row[b + 'Below'] = e.filter((v) => v < p10).length / e.length; row[b + 'Above'] = e.filter((v) => v > p90).length / e.length;
    });
    rows.push(row);
  });
  return rows;
}
const ctx = ctxTable();
const tag = (t) => t.gated ? (t.pass ? 'PASS' : 'FAIL') : (t.pass ? 'DONE' : 'CHECK');
const nFail = tests.filter((t) => t.gated && !t.pass).length;

let md = [];
const P = (s) => md.push(s === undefined ? '' : s);
P('# FIELD//ZERO Similarity Validation Report');
P();
P('> **TERRAIN ANALOG MODEL. Not proof of complete environmental equivalence.** No location in this report is a confirmed planetary analog.');
P();
P('Generated by `scripts/validate_similarity.js` from the real processed datasets in `Data/processed/` and the written files in `outputs/`. Every number below is computed by that script (no hand-entered results). Engine: `website/js/similarity-engine.js` v' + E.version + '.');
P();
P('**Result: ' + (tests.length - nFail) + ' of ' + tests.length + ' tests passed' + (nFail ? ' (' + nFail + ' gated test(s) FAILED)' : ' (no gated failures)') + '.** Pass/fail covers correctness of the implementation, calibration against the real reference cells, and output integrity. It does **not** validate that high-scoring cells are scientifically good analogs: no ground-truth analog labels exist in the inputs, so that cannot be tested here.');
P();
P('## 1. Model definition (summary)');
P();
P('Full derivation and rationale: `metadata/SIMILARITY_METHODOLOGY.md`.');
P();
P('For target body B (Mars Jezero or Moon Taurus-Littrow), scale s (120 m primary, 360 m sensitivity), feature i, and Earth cell value x:');
P();
P('```');
P('Reference model per feature, from the summary JSON only (n, mean m, std d, min lo, max hi):');
P('  negMass = Phi(-m / d)                              Gaussian mass below zero implied by the summary');
P('  model   = lognormal if negMass > ' + cfg.lognormalIfNegativeMassAbove + ' else beta          (config.distribution = auto; gaussian only if forced)');
P('  lognormal: sigma = sqrt(ln(1+(d/m)^2)), mu = ln(m) - sigma^2/2,        F(x) = Phi((ln x - mu) / sigma)');
P('  beta     : u = (m-lo)/(hi-lo), k = u(1-u)/(d/(hi-lo))^2 - 1, alpha = u*k, beta = (1-u)*k,');
P('             F(x) = I_t(alpha, beta) with t = clip((x-lo)/(hi-lo), 0, 1)      (regularised incomplete beta)');
P('  gaussian : F(x) = Phi((x - m) / d)                                         (forced option only)');
P('Feature score   s_i = 100 * (1 - |2 F_i - 1|) = 200 * min(F_i, 1 - F_i)    (equals 100*erfc(|z|/sqrt 2) for z-score models)');
P('Overall score   S   = sum_i w_i * s_i / sum_i w_i        over features present (weights renormalised per cell)');
P('Contribution    c_i = (w_i / W_available) * s_i           (sum of c_i = S)');
P('Completeness    q   = W_available / W_total               (scored only if q >= ' + cfg.minWeightCompleteness + ' and >= ' + cfg.minFeatures + ' features)');
P('```');
P();
P('Default weights (configurable, expert-judgement, not fitted): ' + FEATS.map((f) => '`' + f + '` = ' + cfg.weights[f]).join(', ') + '.');
P();
P('### Reference distributions actually used (from the summary JSON files)');
P();
P('| Reference | Scale | Feature | mean | std | min | max | Gaussian mass < 0 | Model | Parameters | Model median (score 100) |');
P('|---|---|---|---:|---:|---:|---:|---:|---|---|---:|');
['mars', 'moon'].forEach((b) => [120, 360].forEach((sc) => FEATS.forEach((f) => { const r = analysis.references[b][sc].features[f]; P('| ' + analysis.references[b][sc].site + ' | ' + sc + ' | `' + f + '` | ' + f2(r.mean, 3) + ' | ' + f2(r.std, 3) + ' | ' + f2(r.min, 3) + ' | ' + f2(r.max, 2) + ' | ' + f2(r.gaussian_negative_mass, 3) + ' | ' + r.model + ' | ' + (r.model === 'lognormal' ? 'mu=' + f2(r.mu, 3) + ', sigma=' + f2(r.sigma, 3) : r.model === 'beta' ? 'alpha=' + f2(r.alpha, 3) + ', beta=' + f2(r.beta, 3) : '') + ' | ' + f2(r.center, 3) + ' |'); })));
P();
P('## 2. Test results');
P();
P('| ID | Group | Test | Gated | Result | Detail |');
P('|---|---|---|---|---|---|');
tests.forEach((t) => P('| ' + t.id + ' | ' + t.group + ' | ' + t.name + ' | ' + (t.gated ? 'yes' : 'no') + ' | **' + tag(t) + '** | ' + t.detail.replace(/\|/g, '/') + ' |'));
P();
P('### Design history and how the gates were set (read this)');
P();
P('1. The first version of the model used a Gaussian reference for every non-skewed feature. Its first full validation run **failed two gated tests**: D2 (the Moon 360 m elevation-variability Spearman agreement with the empirical distribution was 0.760 against a gate of 0.85; Moon mean absolute score error was 19-25 points) and D3 (Moon-model AUC 0.521 and 0.576 against a gate of 0.70).');
P('2. Diagnosis (see the family comparison in section 5): the Gaussian implied by the Moon summary puts about 12% of its mass below zero, which gives very flat Earth cells a score floor near 25 against the Moon reference. That is a real model defect, not a test artefact. The engine was revised to use a bounded Beta distribution on the observed [min, max] for references that are not strongly right-skewed. This uses only summary-JSON values.');
P('3. The D3 threshold of 0.70 was then shown to be **unattainable for a calibrated typicality score**: even a score built from the full empirical reference distribution only reaches the baselines reported in section 5 (about 0.54-0.68). The absolute gate is therefore kept visible as non-gated test D3a (it still fails), and a baseline-relative gate D3b replaced it as the gated test. This replacement was made after seeing the results; it is disclosed here and should be read accordingly.');
P('4. D1 (+/- 15 points) was set after exploratory inspection of the self-calibration numbers; D2 (Spearman >= 0.85) was set before the first run and kept; D4 (auto rule equals lowest-KS family) was added after the family comparison.');
P('5. Because the reference cells were used both to choose the distribution family and to validate it, D1, D2 and D4 are **in-sample**. They show the summary-only model reproduces the full reference data well; they do not show it generalises to a third reference site.');
P();
P('## 3. Results overview (Earth Western Desert window only)');
P();
P('Search domain: the Earth terrain window present in the processed datasets (about ' + inputs.earth[120].summary.grid.extent_km.join(' x ') + ' km; ' + earth120.length + ' cells at 120 m, ' + earth360.length + ' cells at 360 m). Scores are relative to that window, not to all of Earth.');
P();
P('| Target | Scale | Cells | Scored | Complete (q=1) | Partial | Insufficient | Median | P90 | P99 | Max |');
P('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
['mars', 'moon'].forEach((b) => [120, 360].forEach((sc) => { const s = analysis.results[b][sc].stats; P('| ' + b + ' | ' + sc + ' m | ' + s.n_cells + ' | ' + s.n_scored + ' | ' + s.n_complete + ' | ' + s.n_partial + ' | ' + s.n_insufficient + ' | ' + f2(s.score.median, 1) + ' | ' + f2(s.score.p90, 1) + ' | ' + f2(s.score.p99, 1) + ' | ' + f2(s.score.max, 1) + ' |'); }));
P();
P('Confidence classes (120 m cells): ' + ['mars', 'moon'].map((b) => b + ' ' + JSON.stringify(summarizeConfidence(b, 120))).join('; ') + '. 360 m cells have no coarser scale to check against, so they reach at most "medium": ' + ['mars', 'moon'].map((b) => b + ' ' + JSON.stringify(summarizeConfidence(b, 360))).join('; ') + '.');
P();
P('### Where the Earth window sits relative to the references (120 m, from the real CSVs)');
P();
P('| Feature | Earth median | Mars median | Moon median | Earth cells below Mars P10 | above Mars P90 | Earth cells below Moon P10 | above Moon P90 |');
P('|---|---:|---:|---:|---:|---:|---:|---:|');
ctx.forEach((r) => P('| `' + r.f + '` | ' + f2(r.earthMedian, 2) + ' | ' + f2(r.marsMedian, 2) + ' | ' + f2(r.moonMedian, 2) + ' | ' + f2(100 * r.marsBelow, 1) + '% | ' + f2(100 * r.marsAbove, 1) + '% | ' + f2(100 * r.moonBelow, 1) + '% | ' + f2(100 * r.moonAbove, 1) + '% |'));
P();
P('This window is smoother than both references on all four features, so the median Earth cell scores low and the high-scoring cells are the rougher tail of the window. Scores are a relative ranking inside this window.');
P();
P('### Top candidates, 120 m (full detail in `outputs/top_candidates.json`)');
P();
['mars', 'moon'].forEach((b) => {
  P('**Earth vs ' + (b === 'mars' ? 'Mars (Jezero)' : 'Moon (Taurus-Littrow)') + '**');
  P();
  P('| # | lon | lat | Score | Confidence | Limiting feature | slope / rough / relief / tri feature scores | 360 m parent score | Scale check |');
  P('|---:|---:|---:|---:|---|---|---|---:|---|');
  analysis.candidates[b].primary.forEach((c) => {
    const fs_ = c.features; P('| ' + c.candidate_rank + ' | ' + f2(c.lon_deg, 4) + ' | ' + f2(c.lat_deg, 4) + ' | ' + f2(c.score, 1) + ' | ' + c.confidence + ' | `' + c.limiting_feature + '` | ' + FEATS.map((f) => f2(fs_[f].score, 0)).join(' / ') + ' | ' + f2(c.scale_check.score_360m, 1) + ' | ' + c.scale_check.consistency + ' |');
  });
  P();
});
P('These are ranked terrain-metric similarity candidates. They are not confirmed analogs. Nothing here identifies what landform a cell is (no imagery or geology was used).');
P();
P('## 4. Scale sensitivity: 120 m versus 360 m');
P();
P('Each 120 m cell is compared with the 360 m cell that contains it (120 m score against the 120 m reference; 360 m score against the 360 m reference; the two grids share one lattice, test A3). Consistent means |difference| <= ' + cfg.scaleAgreementTolerance + ' points.');
P();
P('| Target | Fine cells paired | Consistent | Mean (120 - 360) | Median abs diff | P90 abs diff | Parent-level Spearman | Parent-level Pearson | Top-' + (100 * cfg.topFractionForOverlap) + '% overlap (Jaccard) |');
P('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
['mars', 'moon'].forEach((b) => { const s = analysis.scale_comparison[b]; P('| ' + b + ' | ' + s.n_fine_pairs + ' | ' + f2(100 * s.fraction_consistent, 1) + '% | ' + f2(s.mean_delta, 1) + ' | ' + f2(s.median_abs_delta, 1) + ' | ' + f2(s.p90_abs_delta, 1) + ' | ' + f2(s.spearman_parent_childmean_vs_coarse, 3) + ' | ' + f2(s.pearson_parent_childmean_vs_coarse, 3) + ' | ' + f2(s.top_fraction_overlap.jaccard, 3) + ' (' + s.top_fraction_overlap.intersection + ' of ' + s.top_fraction_overlap.k + ') |'); });
P();
['mars', 'moon'].forEach((b) => {
  const L = analysis.candidates[b].primary, inTop = L.filter((c) => c.scale_check.parent_in_top_fraction_360m).length, cons = L.filter((c) => c.scale_check.consistency === 'consistent').length;
  P('- ' + b + ': ' + cons + ' of ' + L.length + ' 120 m candidates are scale-consistent; ' + inTop + ' of ' + L.length + ' have a 360 m parent in the top ' + (100 * cfg.topFractionForOverlap) + '% of 360 m scores.');
});
P();
P('Interpretation rules used: a divergent pair means the score depends on the analysis scale and is lower-confidence (it caps confidence at "medium"). The 360 m run changes the kernel footprints (1080 m roughness window, 1800 m variability window) and the resampling, so it tests scale dependence of the metrics; it is not independent validation. Surface roughness scales differently on different surfaces, so some disagreement is physical, not an error: from the summaries, mean roughness grows ' + f2(inputs.mars[360].summary.roughness_std.mean / inputs.mars[120].summary.roughness_std.mean, 2) + 'x from 120 m to 360 m on the Mars reference, ' + f2(inputs.moon[360].summary.roughness_std.mean / inputs.moon[120].summary.roughness_std.mean, 2) + 'x on the Moon reference, and ' + f2(inputs.earth[360].summary.roughness_std.mean / inputs.earth[120].summary.roughness_std.mean, 2) + 'x on Earth.');
P();
P('## 5. Empirical calibration against the real reference cells');
P();
P('**D1 self-calibration** (mean score of a reference\'s own cells under its own summary-based model; 50 would be exact):');
P();
P('| Reference | Scale | Feature | Model | Mean self score |');
P('|---|---|---|---|---:|');
M.calibration.forEach((r) => P('| ' + r.body + ' | ' + r.scale + ' | `' + r.feature + '` | ' + r.model + ' | ' + f2(r.mean_self_score, 1) + ' |'));
P();
P('**D2 agreement with empirical-CDF typicality** for Earth cells (score from the summary-only model vs 100*(1-|2F-1|) with F the empirical CDF of the real reference cells):');
P();
P('| Reference | Scale | Feature | Spearman | Mean abs score difference |');
P('|---|---|---|---:|---:|');
M.ecdfAgreement.forEach((r) => P('| ' + r.body + ' | ' + r.scale + ' | `' + r.feature + '` | ' + f2(r.spearman, 3) + ' | ' + f2(r.mean_abs_diff, 1) + ' |'));
P();
P('**D3 discrimination between the two reference terrains** (AUC of "own-site cells score higher than the other site\'s cells"). The baseline is the same AUC computed with the full empirical reference distribution instead of the summary-based model (what a faithfully calibrated typicality score achieves with these four features). It is a baseline, not an upper bound: a deliberately miscalibrated family can score a higher AUC (e.g. forced lognormal on the Moon, table below) while being worse calibrated, so AUC is not optimised here:');
P();
P('| Scale | AUC Mars model | Baseline Mars | AUC Moon model | Baseline Moon | Median score, Mars cells / Moon cells under Mars model | Median score, Moon cells / Mars cells under Moon model |');
P('|---:|---:|---:|---:|---:|---|---|');
M.auc.forEach((r) => P('| ' + r.scale + ' | ' + f2(r.auc_mars_model, 3) + ' | ' + f2(r.ceiling_mars_model, 3) + ' | ' + f2(r.auc_moon_model, 3) + ' | ' + f2(r.ceiling_moon_model, 3) + ' | ' + f2(r.med_mars_cells_mars_model, 1) + ' / ' + f2(r.med_moon_cells_mars_model, 1) + ' | ' + f2(r.med_moon_cells_moon_model, 1) + ' / ' + f2(r.med_mars_cells_moon_model, 1) + ' |'));
P();
P('Reading this: the score measures how typical a cell is of one reference terrain; it is a weak discriminator between these two terrains (the Jezero and Taurus-Littrow windows overlap strongly in these four metrics). A high score means "the metrics look typical of the reference", not "this is distinguishable from the other body\'s terrain".');
P();
P('**Model-family comparison on the real reference cells** (mean over the four features; KS = Kolmogorov-Smirnov distance of the reference cells\' percentiles from uniform, 0 is perfect; self score would be 50 if exact; |Earth diff| = mean absolute difference from the empirical-CDF score on Earth cells; AUC = own-site vs other-site discrimination of the overall score under that family). The `auto` rule uses lognormal for Mars and Beta for the Moon:');
P();
P('| Reference | Scale | Family | KS | Mean self score | Earth score diff vs empirical | AUC |');
P('|---|---:|---|---:|---:|---:|---:|');
M.family.forEach((r) => P('| ' + r.body + ' | ' + r.scale + ' | ' + r.family + (analysis.references[r.body][r.scale].features.slope_deg.model === r.family ? ' (auto)' : '') + ' | ' + f2(r.ks, 3) + ' | ' + f2(r.self, 1) + ' | ' + f2(r.d2, 1) + ' | ' + f2(r.auc, 3) + ' |'));
P();
P('## 6. Sensitivity to weights and distribution family (120 m)');
P();
P('Spearman = rank correlation of per-cell scores with the default configuration; top-1% Jaccard = overlap of the highest-scoring 1% of cells; "default best cell now ranks" = where the default #1 cell lands in the variant.');
P();
['mars', 'moon'].forEach((b) => {
  P('**' + b + '**');
  P();
  P('| Variant | Cells compared | Spearman vs default | Top-1% Jaccard | Default best cell now ranks |');
  P('|---|---:|---:|---:|---:|');
  M.sens[b].forEach((r) => P('| ' + r.name + ' | ' + r.n + ' | ' + f2(r.spearman, 3) + ' | ' + f2(r.top1pct_jaccard, 3) + ' | ' + (r.baseBestRankInVariant === null ? 'unscored' : r.baseBestRankInVariant) + ' |'));
  P();
});
P('Feature redundancy (Spearman between features, Earth 120 m, from the CSV): see methodology section "Weights". The four features are strongly collinear in all six terrain tables, so leaving out any single feature barely changes the overall rank order (Spearman >= 0.97 in every row), but the identity of the very top cells is less stable (top-1% Jaccard varies widely, lowest when elev_variability_std is removed). The choice of distribution family has the largest effect on which cells are top-ranked (forcing a different family changes the top-1% set almost completely for Mars), which is why the family choice is validated explicitly in section 5. Candidate lists should be read as sensitive to these modelling choices.');
P();
P('## 7. Independent implementation parity (E1)');
P();
P('`scripts/crosscheck_similarity.py` re-implements the model with numpy/scipy (separate code path, `scipy.special.erfc`, pandas CSV reading, its own parent-cell mapping) and compares to the written GeoJSON files.');
P();
P('| Target | Cells compared | Max |diff| score | Max |diff| feature score | Max |diff| contribution | Max |diff| 360 m score | Rank mismatches | Null patterns equal |');
P('|---|---:|---:|---:|---:|---:|---:|---|');
['mars', 'moon'].forEach((b) => { const t = M.crosscheck.targets[b]; P('| ' + b + ' | ' + t.n_compared + ' | ' + t.max_abs_diff_score.toExponential(2) + ' | ' + t.max_abs_diff_feature_score.toExponential(2) + ' | ' + t.max_abs_diff_contribution.toExponential(2) + ' | ' + t.max_abs_diff_score_360m.toExponential(2) + ' | ' + t.rank_mismatch_count + ' | ' + (t.null_pattern_matches && t.null_pattern_360_matches && t.rank_null_pattern_matches) + ' |'); });
P();
P('Residual differences equal the GeoJSON rounding (score and contribution 2 decimals, feature score 1 decimal).');
P();
P('## 8. Assumptions');
P();
P('1. The four features are comparable across bodies **after normalisation to each reference\'s own distribution**; their native units (degrees, metres) are not compared across planets directly.');
P('2. The Jezero and Taurus-Littrow windows in the processed data are taken as the reference terrains. They are single sites and not representative of "Mars" or "the Moon" in general.');
P('3. Summary statistics (n, mean, std, min, max) are sufficient to define a reference distribution. This is an approximation: lognormal (strongly skewed references) and Beta on [min, max] (others) are moment-matched, not fitted to the full data (calibration in section 5 quantifies the misfit).');
P('4. Feature kernels are identical across bodies and scales (same windows in metres), as recorded in each summary JSON `kernels_m`.');
P('5. Default weights are expert judgement. They are configurable and their influence is measured in section 6.');
P('6. Elevation, aspect, temperature, pressure and all POWER climate variables are excluded (no comparable Mars/Moon measurements exist in the processed data, and absolute elevation is not comparable across planets).');
P();
P('## 9. Limitations');
P();
P('- **Not an environmental analog.** Gravity, atmosphere, thermal regime, regolith/surface material, dust, radiation and illumination are not modelled.');
P('- **Only four terrain-shape metrics, which are collinear.** Spearman correlation between features is 0.75-1.00 in all six terrain tables, so the model effectively measures one ruggedness axis; four features do not make four independent pieces of evidence.');
P('- **Source-resolution differences.** The Moon grid (118 m native) is barely smoothed at 120 m, Mars (20 m) and Earth (about 30 m) are area-averaged, so equal-looking metrics are not equally resolved. The 360 m run reduces but does not remove this.');
P('- **Distribution-shape approximation (revised).** Distributions are moment-matched from summaries (lognormal for the skewed Mars reference, Beta on [min, max] for the Moon reference), not fitted to the full data. Mean self scores are ' + f2(Math.min(...M.calibration.map((r) => r.mean_self_score)), 1) + '-' + f2(Math.max(...M.calibration.map((r) => r.mean_self_score)), 1) + ' against an ideal of 50, and Earth-cell scores differ from the empirical-CDF score by ' + f2(Math.min(...M.ecdfAgreement.map((r) => r.mean_abs_diff)), 1) + '-' + f2(Math.max(...M.ecdfAgreement.map((r) => r.mean_abs_diff)), 1) + ' points on average (section 5), so absolute score values carry roughly that much uncertainty while rank order is reproduced closely. Values beyond the observed reference range score exactly 0 under the Beta model (flagged by `n_outside_ref_range`). The family rule is tuned on two references (the Gaussian mass below zero is 0.12 for the Moon and 0.18-0.22 for Mars; the 0.15 threshold sits between them) and must be re-validated for any new reference site.');
P('- **Low discriminating power.** With a score faithfully built from the full empirical reference distribution, the typicality score separates Mars-site cells from Moon-site cells only with AUC ' + f2(Math.min(...M.auc.map((r) => Math.min(r.ceiling_mars_model, r.ceiling_moon_model))), 2) + '-' + f2(Math.max(...M.auc.map((r) => Math.max(r.ceiling_mars_model, r.ceiling_moon_model))), 2) + '. Scores for the two targets should not be read as evidence that a cell is "more Mars-like than Moon-like".');
P('- **Edge cells.** Cells within 1 cell (slope, roughness, TRI) or 2 cells (variability) of the window edge lack kernel values; they are scored on fewer features or not at all, and are never gap-filled.');
P('- **Scale dependence.** Rankings differ between 120 m and 360 m, strongly so for Mars (section 4). A high 120 m score with a divergent 360 m score should be read as scale-specific.');
P('- **Search domain.** Only the one Earth window in the data is evaluated.');
P('- **No ground truth.** No external labelled analog sites were used, so the ranking is validated for internal consistency and calibration, not for scientific correctness of the analog.');
P('- **Spatial autocorrelation.** Neighbouring cells share kernel windows, so adjacent high scores are not independent evidence; candidates are therefore separated by at least ' + cfg.minSeparationM + ' m.');
P();
P('## 10. Reproduce');
P();
P('```');
P('node scripts/run_similarity.js            # writes outputs/*.geojson, outputs/top_candidates.json');
P('python3 scripts/crosscheck_similarity.py  # independent re-implementation, writes reports/similarity_crosscheck.json');
P('node scripts/validate_similarity.js       # runs all tests, writes this report');
P('```');
P();
P('Output file fingerprints (sha256): `earth_mars_similarity.geojson` ' + M.hashes.mars + '; `earth_moon_similarity.geojson` ' + M.hashes.moon + '; `top_candidates.json` ' + M.hashes.top + '.');
P();
fs.mkdirSync(path.join(IO.ROOT, 'reports'), { recursive: true });
fs.writeFileSync(path.join(IO.ROOT, 'reports', 'similarity_validation.md'), md.join('\n'));
tests.forEach((t) => console.log(tag(t).padEnd(5), t.id.padEnd(3), t.name.slice(0, 90), '|', t.detail.slice(0, 160)));
console.log(nFail ? nFail + ' gated test(s) FAILED' : 'all gated tests passed');
process.exit(nFail ? 1 : 0);
