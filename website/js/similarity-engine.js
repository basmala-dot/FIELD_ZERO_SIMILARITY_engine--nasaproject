/*!
 * FIELD//ZERO similarity engine  (v1.0.0)
 *
 *   TERRAIN ANALOG MODEL. NOT PROOF OF ENVIRONMENTAL EQUIVALENCE.
 *
 * Scores every Earth (Western Desert) terrain cell against a Mars (Jezero) and a Moon
 * (Taurus-Littrow) reference terrain, using only four DEM-derived surface-shape metrics:
 *
 *     slope_deg, roughness_std, elev_variability_std, tri
 *
 * Method in one paragraph (full definition: metadata/SIMILARITY_METHODOLOGY.md):
 *   1. For each reference (body, scale) a distribution per feature is rebuilt ONLY from the
 *      reference summary JSON (n, mean, std, min, max). Nothing is read from the reference CSV.
 *   2. Each Earth cell value is placed on that reference distribution as a percentile F in [0,1]
 *      (lognormal for strongly right-skewed references, bounded Beta on [min,max] otherwise;
 *      Gaussian is available as a forced option). Lognormal/Gaussian also give a z-score.
 *   3. Feature score  s_i = 100 * (1 - |2F - 1|) = 200 * min(F, 1-F)  (two-sided tail probability;
 *      equals 100 * erfc(|z|/sqrt(2)) for z-score models). 100 = at the reference median,
 *      0 = at or beyond the observed reference minimum/maximum (Beta) or far in the tail.
 *   4. Overall score  S = sum_i( w_i * s_i ) / sum_i( w_i ), over the features that are present.
 *      Missing features are never filled; their weight is removed and the remaining weights are
 *      renormalised. Contribution of feature i = (w_i / W_available) * s_i, so contributions sum to S.
 *   5. 120 m is the primary scale; 360 m is a sensitivity run scored against the 360 m references.
 *
 * Not used, by design: absolute elevation, aspect, temperature, pressure, or any quantity that is
 * not present in the processed terrain datasets.
 *
 * Works in browsers (<script src="js/similarity-engine.js">) and Node 18+ (require).
 * Browser:  const out = FieldZeroSimilarity.analyzeLoaded(FieldZeroData.data);
 * Node:     const E = require('./similarity-engine.js'); const out = E.analyze(inputs);
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FieldZeroSimilarity = factory();
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function () {
  'use strict';

  var VERSION = '1.0.0';
  var MODEL_NAME = 'FIELD//ZERO terrain analog similarity model';
  var MODEL_LABEL = 'TERRAIN ANALOG MODEL: compares four DEM-derived surface-shape metrics only. ' +
    'It is not proof of complete environmental equivalence.';
  var DISCLAIMER = 'Scores describe statistical closeness of terrain-shape metrics to the reference distribution of one ' +
    'Mars site (Jezero) or one Moon site (Taurus-Littrow). They do not describe geology, composition, regolith, ' +
    'gravity, atmosphere, temperature, pressure, radiation, illumination or any other environmental property. ' +
    'No location in this output is a confirmed planetary analog; ranked locations are candidates for further study.';

  // Features the model is allowed to use. Elevation is excluded on purpose (absolute elevation is not
  // comparable across planets: different datums, different zero levels). Aspect is circular and not a
  // roughness measure. Anything else (temperature, pressure, ...) has no comparable measurement here.
  var ALLOWED_FEATURES = ['slope_deg', 'roughness_std', 'elev_variability_std', 'tri'];
  var FORBIDDEN_FEATURES = ['elevation', 'aspect_deg', 'temperature', 'pressure', 'T2M', 'T2M_MAX', 'T2M_MIN', 'PS'];

  var FEATURE_INFO = {
    slope_deg: { label: 'Slope', unit: 'deg', kernel: '3x3 central difference (baseline 2 x scale)' },
    roughness_std: { label: 'Roughness (local std of elevation)', unit: 'm', kernel: '3x3 window (3 x scale)' },
    elev_variability_std: { label: 'Elevation variability (broad-window std)', unit: 'm', kernel: '5x5 window (5 x scale)' },
    tri: { label: 'Terrain Ruggedness Index (Riley)', unit: 'm', kernel: '3x3 Riley' }
  };

  var DEFAULT_CONFIG = {
    features: ALLOWED_FEATURES.slice(),
    // Expert-judgement defaults, NOT fitted. See methodology section "Weights".
    // roughness_std and tri are near-duplicates (Spearman 0.95-1.00 in all six terrain tables), so together they get 0.40,
    // i.e. one "local ruggedness" group; slope (gradient) and elev_variability (broad relief) are 0.30 each.
    weights: { slope_deg: 0.30, roughness_std: 0.20, elev_variability_std: 0.30, tri: 0.20 },
    // 'auto' | 'gaussian' | 'lognormal' | 'beta'. 'auto': per reference feature, lognormal if the Gaussian implied by the
    // summary would put more than this fraction of its mass below zero (strong right skew against a zero bound);
    // otherwise a Beta distribution on [min, max], moment-matched to mean and std. A plain Gaussian is NOT chosen by
    // 'auto': on the real Moon reference it leaves ~12% of its mass below zero and inflates flat-terrain scores
    // (see reports/similarity_validation.md, model-family comparison). It remains available as a forced option.
    distribution: 'auto',
    lognormalIfNegativeMassAbove: 0.15,
    // A cell is scored only if the available weight share is >= this AND at least minFeatures features are present.
    minWeightCompleteness: 0.5,
    minFeatures: 2,
    // log() floor for values <= 0 (flagged as 'floored'); never triggered by the current datasets.
    logFloor: 1e-6,
    // 120 m score vs its parent 360 m cell score; |delta| <= tolerance => 'consistent'.
    scaleAgreementTolerance: 15,
    // Confidence classes need these completeness levels (see assignConfidence).
    confidenceMediumMinCompleteness: 0.7,
    // Candidate list.
    topN: 10,
    minSeparationM: 2000,
    candidateMinCompleteness: 1.0,
    topFractionForOverlap: 0.05,
    primaryScaleM: 120,
    sensitivityScaleM: 360
  };

  // ------------------------------------------------------------------ small numeric helpers
  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  /**
   * Complementary error function, accurate to ~1e-15 (relative) for the range used here.
   *  |x| < 3 : erf from the all-positive series  erf(x) = 2/sqrt(pi) * exp(-x^2) * sum_n 2^n x^(2n+1) / (1*3*...*(2n+1))
   *  |x| >= 3: continued fraction  erfc(x) = exp(-x^2)/sqrt(pi) / (x + (1/2)/(x + (2/2)/(x + (3/2)/(x + ...))))
   */
  function erfc(x) {
    if (x !== x) return NaN;
    var z = Math.abs(x), r;
    if (z < 3) {
      var term = z, sum = z, n = 0;
      while (term > 1e-17 * sum && n < 200) { n++; term *= 2 * z * z / (2 * n + 1); sum += term; }
      r = 1 - (2 / Math.sqrt(Math.PI)) * Math.exp(-z * z) * sum;
    } else {
      var t = z;
      for (var k = 80; k >= 1; k--) t = z + (k / 2) / t;
      r = Math.exp(-z * z) / Math.sqrt(Math.PI) / t;
    }
    return x >= 0 ? r : 2 - r;
  }
  /** Standard normal CDF. */
  function normCdf(z) { return 0.5 * erfc(-z / Math.SQRT2); }

  /** ln Gamma(x), x > 0 (Lanczos g=7, n=9; ~1e-15 relative). */
  var LANCZOS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  function lgamma(x) {
    if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lgamma(1 - x);
    x -= 1;
    var a = LANCZOS[0], t = x + 7.5;
    for (var i = 1; i < 9; i++) a += LANCZOS[i] / (x + i);
    return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
  }
  /** Continued fraction for the incomplete beta function (modified Lentz). */
  function betacf(x, a, b) {
    var TINY = 1e-300, qab = a + b, qap = a + 1, qam = a - 1, c = 1, d = 1 - qab * x / qap, m, m2, aa, del, h;
    if (Math.abs(d) < TINY) d = TINY;
    d = 1 / d; h = d;
    for (m = 1; m <= 1000; m++) {
      m2 = 2 * m;
      aa = m * (b - m) * x / ((qam + m2) * (a + m2));
      d = 1 + aa * d; if (Math.abs(d) < TINY) d = TINY;
      c = 1 + aa / c; if (Math.abs(c) < TINY) c = TINY;
      d = 1 / d; h *= d * c;
      aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
      d = 1 + aa * d; if (Math.abs(d) < TINY) d = TINY;
      c = 1 + aa / c; if (Math.abs(c) < TINY) c = TINY;
      d = 1 / d; del = d * c; h *= del;
      if (Math.abs(del - 1) < 1e-15) break;
    }
    return h;
  }
  /** Regularised incomplete beta I_x(a,b) and its complement, computed on whichever side is numerically stable. Returns [lower, upper]. */
  function betaTails(x, a, b) {
    if (x <= 0) return [0, 1];
    if (x >= 1) return [1, 0];
    var bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
    if (x < (a + 1) / (a + b + 2)) { var lo = bt * betacf(x, a, b) / a; return [lo, 1 - lo]; }
    var up = bt * betacf(1 - x, b, a) / b; return [1 - up, up];
  }

  function round(v, d) {
    if (v === null || v === undefined || !isFinite(v)) return null;
    var f = Math.pow(10, d);
    return Math.round(v * f) / f;
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  // ------------------------------------------------------------------ configuration
  /**
   * Merge user options over DEFAULT_CONFIG and validate. Weights are normalised to sum to 1.
   * Throws Error with a specific message for anything unusable. Never silently repairs.
   */
  function resolveConfig(user) {
    var cfg = Object.assign({}, clone(DEFAULT_CONFIG), user ? clone(user) : {});
    if (!Array.isArray(cfg.features) || !cfg.features.length) throw new Error('config.features must be a non-empty array.');
    cfg.features.forEach(function (f) {
      if (FORBIDDEN_FEATURES.indexOf(f) !== -1) {
        throw new Error('Feature "' + f + '" is not allowed: absolute elevation, aspect, temperature and pressure are not compared across planets.');
      }
      if (ALLOWED_FEATURES.indexOf(f) === -1) throw new Error('Unknown feature "' + f + '". Allowed: ' + ALLOWED_FEATURES.join(', '));
    });
    if (cfg.features.length !== new Set(cfg.features).size) throw new Error('config.features contains duplicates.');
    var w = cfg.weights || {}, sum = 0;
    Object.keys(w).forEach(function (k) {
      if (cfg.features.indexOf(k) === -1) throw new Error('Weight given for "' + k + '", which is not in config.features.');
    });
    cfg.features.forEach(function (f) {
      if (!isNum(w[f])) throw new Error('Missing or non-numeric weight for feature "' + f + '".');
      if (w[f] < 0) throw new Error('Weight for "' + f + '" is negative.');
      sum += w[f];
    });
    if (!(sum > 0)) throw new Error('Weights sum to zero.');
    var norm = {};
    cfg.features.forEach(function (f) { norm[f] = w[f] / sum; });
    cfg.weights = norm;
    if (['auto', 'gaussian', 'lognormal', 'beta'].indexOf(cfg.distribution) === -1) throw new Error('config.distribution must be auto, gaussian, lognormal or beta.');
    ['minWeightCompleteness', 'candidateMinCompleteness', 'confidenceMediumMinCompleteness', 'topFractionForOverlap'].forEach(function (k) {
      if (!isNum(cfg[k]) || cfg[k] < 0 || cfg[k] > 1) throw new Error('config.' + k + ' must be a number in [0, 1].');
    });
    if (!(cfg.minFeatures >= 1 && cfg.minFeatures <= cfg.features.length)) throw new Error('config.minFeatures must be between 1 and the number of features.');
    if (!(cfg.topN >= 1)) throw new Error('config.topN must be >= 1.');
    return cfg;
  }

  // ------------------------------------------------------------------ reference distributions
  /**
   * Build the per-feature reference model from a terrain summary JSON (as written by the pipeline).
   * Only n, mean, std, min, max of each feature are used. Throws if any required statistic is absent.
   */
  function buildReference(summary, cfg) {
    cfg = cfg || resolveConfig();
    if (!summary || typeof summary !== 'object') throw new Error('buildReference: summary JSON is missing.');
    var ref = {
      body: summary.body, site: summary.site, scale_m: summary.scale_m,
      source: summary.provenance ? { dataset: summary.provenance.dataset, source_sha256: summary.provenance.source_sha256 } : null,
      summary_generated_utc: summary.generated_utc || null,
      features: {}
    };
    cfg.features.forEach(function (f) {
      var s = summary[f];
      if (!s) throw new Error('Reference summary (' + summary.site + ' ' + summary.scale_m + ' m) has no block for "' + f + '".');
      ['n', 'mean', 'std', 'min', 'max'].forEach(function (k) {
        if (!isNum(s[k])) throw new Error('Reference summary ' + summary.site + ' ' + summary.scale_m + ' m: "' + f + '.' + k + '" is missing or not numeric.');
      });
      if (!(s.n > 1)) throw new Error('Reference "' + f + '" has n <= 1.');
      if (!(s.std > 0)) throw new Error('Reference "' + f + '" has std <= 0; z-scores are undefined.');
      var negMass = normCdf(-s.mean / s.std);        // Gaussian mass below zero implied by the summary
      var model = cfg.distribution;
      if (model === 'auto') model = negMass > cfg.lognormalIfNegativeMassAbove ? 'lognormal' : 'beta';
      var fe = { n: s.n, mean: s.mean, std: s.std, min: s.min, max: s.max, gaussian_negative_mass: negMass, model: model };
      if (model === 'lognormal') {
        if (!(s.mean > 0)) throw new Error('Lognormal model needs mean > 0 for "' + f + '".');
        var cv2 = (s.std / s.mean) * (s.std / s.mean);
        fe.sigma = Math.sqrt(Math.log(1 + cv2));          // sd of ln(x), method of moments from mean and std
        fe.mu = Math.log(s.mean) - 0.5 * fe.sigma * fe.sigma; // mean of ln(x)
        fe.center = Math.exp(fe.mu);                      // median of the lognormal
      } else if (model === 'beta') {
        if (!(s.max > s.min)) throw new Error('Beta model needs max > min for "' + f + '".');
        var u = (s.mean - s.min) / (s.max - s.min), v = (s.std / (s.max - s.min)) * (s.std / (s.max - s.min));
        if (!(u > 0 && u < 1)) throw new Error('Beta model needs min < mean < max for "' + f + '".');
        var k = u * (1 - u) / v - 1;
        if (!(k > 0)) throw new Error('Beta moment matching infeasible for "' + f + '" (std too large for the [min,max] range).');
        fe.alpha = u * k; fe.beta = (1 - u) * k;                 // method of moments on the normalised range
        // centre = model median (F = 0.5), found by bisection on the normalised range
        var lo = 0, hi = 1, mid, i2;
        for (i2 = 0; i2 < 80; i2++) { mid = 0.5 * (lo + hi); if (betaTails(mid, fe.alpha, fe.beta)[0] < 0.5) lo = mid; else hi = mid; }
        fe.center = s.min + 0.5 * (lo + hi) * (s.max - s.min);
        fe.mu = null; fe.sigma = null;
      } else {
        fe.mu = s.mean; fe.sigma = s.std; fe.center = s.mean;
      }
      ref.features[f] = fe;
    });
    return ref;
  }

  // ------------------------------------------------------------------ feature + cell scoring
  /**
   * Score one value against one reference feature.
   * Returns { status: 'ok'|'missing'|'invalid', floored, outside, z, percentile, score }.
   *   percentile = F(x) under the reference model; score = 200 * min(F, 1 - F).
   *   z is the standardised value for gaussian/lognormal models and null for beta.
   * 'missing' = null/undefined/NaN/non-finite. 'invalid' = negative (metrics are non-negative). Both are excluded.
   */
  function scoreFeature(value, fe, cfg) {
    cfg = cfg || DEFAULT_CONFIG;
    if (value === null || value === undefined || !isNum(value)) return { status: 'missing', floored: false, outside: false, z: null, percentile: null, score: null };
    if (value < 0) return { status: 'invalid', floored: false, outside: false, z: null, percentile: null, score: null };
    var floored = false, z = null, F, s;
    if (fe.model === 'beta') {
      var t = betaTails((value - fe.min) / (fe.max - fe.min), fe.alpha, fe.beta);
      F = t[0]; s = 200 * Math.min(t[0], t[1]);
    } else {
      if (fe.model === 'lognormal') {
        var v = value;
        if (v <= 0) { v = cfg.logFloor; floored = true; }
        z = (Math.log(v) - fe.mu) / fe.sigma;
      } else z = (value - fe.mu) / fe.sigma;
      s = 100 * erfc(Math.abs(z) / Math.SQRT2);
      F = normCdf(z);
    }
    if (s > 100) s = 100; if (s < 0) s = 0;
    return { status: 'ok', floored: floored, outside: value < fe.min || value > fe.max, z: z, percentile: F, score: s };
  }

  /**
   * Score one cell. `vals` maps feature name -> value (or null).
   * Returns the full explanation: per-feature {value, status, z, score, weight, effective_weight, contribution, shortfall}.
   */
  function scoreCell(vals, ref, cfg) {
    var feats = {}, W = 0, Wall = 0, used = 0, f, i, nOut = 0, nBad = 0, nFloor = 0;
    for (i = 0; i < cfg.features.length; i++) {
      f = cfg.features[i];
      var r = scoreFeature(vals[f], ref.features[f], cfg);
      var w = cfg.weights[f];
      Wall += w;
      feats[f] = { value: isNum(vals[f]) ? vals[f] : null, status: r.status, z: r.z, percentile: r.percentile, score: r.score, weight: w, effective_weight: null, contribution: null, shortfall: null, outside_ref_range: r.outside };
      if (r.status === 'ok' && w > 0) { W += w; used++; if (r.outside) nOut++; if (r.floored) nFloor++; }
      if (r.status === 'invalid') nBad++;
    }
    var completeness = Wall > 0 ? W / Wall : 0;
    var out = { score: null, status: 'insufficient', completeness: completeness, n_features_used: used, n_outside_ref_range: nOut, n_invalid: nBad, n_floored: nFloor, limiting_feature: null, features: feats };
    if (used >= cfg.minFeatures && completeness >= cfg.minWeightCompleteness - 1e-12 && W > 0) {
      var S = 0, worst = -1;
      for (i = 0; i < cfg.features.length; i++) {
        f = cfg.features[i];
        var ft = feats[f];
        if (ft.status !== 'ok' || ft.weight <= 0) continue;
        ft.effective_weight = ft.weight / W;
        ft.contribution = ft.effective_weight * ft.score;
        ft.shortfall = ft.effective_weight * (100 - ft.score);   // points lost to this feature; contribution + shortfall = effective_weight * 100
        S += ft.contribution;
        if (ft.shortfall > worst) { worst = ft.shortfall; out.limiting_feature = f; }
      }
      out.score = Math.min(100, Math.max(0, S));
      out.status = 'scored';
    }
    return out;
  }

  /**
   * Score every row of a terrain table. Rows need the feature columns plus x_m_localTM, y_m_localTM, lon_deg, lat_deg.
   * Returns { cells, stats } where cells[i] corresponds to rows[i] and carries rank (1 = best) among scored cells.
   */
  function scoreTable(rows, ref, cfg) {
    var cells = new Array(rows.length), n = rows.length, i, vals = {}, scored = [];
    for (i = 0; i < n; i++) {
      var row = rows[i];
      cfg.features.forEach(function (f) { vals[f] = row[f]; });
      var c = scoreCell(vals, ref, cfg);
      c.index = i; c.x = row.x_m_localTM; c.y = row.y_m_localTM; c.lon = row.lon_deg; c.lat = row.lat_deg;
      c.rank = null; c.confidence = null; c.scale = null;
      cells[i] = c;
      if (c.status === 'scored') scored.push(c);
    }
    scored.sort(function (a, b) { return (b.score - a.score) || (b.completeness - a.completeness) || (a.index - b.index); });
    for (i = 0; i < scored.length; i++) scored[i].rank = i + 1;
    return { cells: cells, ranked: scored, stats: tableStats(cells, cfg) };
  }

  function quantile(sorted, q) {
    if (!sorted.length) return null;
    var p = (sorted.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (p - lo);
  }

  function tableStats(cells, cfg) {
    var n = cells.length, st = { n_cells: n, n_scored: 0, n_insufficient: 0, n_complete: 0, n_partial: 0, per_feature_missing: {}, per_feature_invalid: {}, n_with_outside_ref_range: 0 };
    cfg.features.forEach(function (f) { st.per_feature_missing[f] = 0; st.per_feature_invalid[f] = 0; });
    var scores = [];
    cells.forEach(function (c) {
      cfg.features.forEach(function (f) {
        if (c.features[f].status === 'missing') st.per_feature_missing[f]++;
        if (c.features[f].status === 'invalid') st.per_feature_invalid[f]++;
      });
      if (c.status === 'scored') {
        st.n_scored++; scores.push(c.score);
        if (c.completeness >= 1 - 1e-12) st.n_complete++; else st.n_partial++;
        if (c.n_outside_ref_range > 0) st.n_with_outside_ref_range++;
      } else st.n_insufficient++;
    });
    scores.sort(function (a, b) { return a - b; });
    st.score = scores.length ? { min: scores[0], p25: quantile(scores, 0.25), median: quantile(scores, 0.5), p75: quantile(scores, 0.75), p90: quantile(scores, 0.9), p99: quantile(scores, 0.99), max: scores[scores.length - 1], mean: scores.reduce(function (a, b) { return a + b; }, 0) / scores.length } : null;
    return st;
  }

  // ------------------------------------------------------------------ rank statistics
  function averageRanks(values) {
    var idx = values.map(function (v, i) { return i; }).sort(function (a, b) { return values[a] - values[b]; });
    var r = new Array(values.length), i = 0;
    while (i < idx.length) {
      var j = i;
      while (j + 1 < idx.length && values[idx[j + 1]] === values[idx[i]]) j++;
      var avg = (i + j) / 2 + 1;
      for (var k = i; k <= j; k++) r[idx[k]] = avg;
      i = j + 1;
    }
    return r;
  }
  function pearson(a, b) {
    var n = a.length, i, ma = 0, mb = 0;
    if (n < 3) return null;
    for (i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
    ma /= n; mb /= n;
    var sab = 0, saa = 0, sbb = 0;
    for (i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) * (a[i] - ma); sbb += (b[i] - mb) * (b[i] - mb); }
    return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : null;
  }
  /** Spearman rank correlation (average ranks for ties). */
  function spearman(a, b) { return pearson(averageRanks(a), averageRanks(b)); }

  // ------------------------------------------------------------------ scale comparison (120 m vs 360 m)
  /**
   * Each fine cell lies inside exactly one coarse cell (both grids share one local-TM lattice and the coarse cell
   * size is an integer multiple of the fine one). Attaches c.scale = { parent_index, score_coarse, delta, consistency }
   * to every fine cell and returns summary statistics.
   */
  function compareScales(fine, coarse, fineScaleM, coarseScaleM, fineRows, coarseRows, cfg) {
    var x0 = Infinity, y0 = Infinity, i;
    for (i = 0; i < coarseRows.length; i++) { if (coarseRows[i].x_m_localTM < x0) x0 = coarseRows[i].x_m_localTM; if (coarseRows[i].y_m_localTM < y0) y0 = coarseRows[i].y_m_localTM; }
    var map = {}, half = coarseScaleM / 2;
    for (i = 0; i < coarseRows.length; i++) {
      var kx = Math.round((coarseRows[i].x_m_localTM - x0) / coarseScaleM), ky = Math.round((coarseRows[i].y_m_localTM - y0) / coarseScaleM);
      map[kx + '_' + ky] = i;
    }
    var children = {}, deltas = [], consistent = 0, divergent = 0, noPair = 0;
    for (i = 0; i < fine.cells.length; i++) {
      var fc = fine.cells[i], row = fineRows[i];
      var px = Math.floor((row.x_m_localTM - x0 + half) / coarseScaleM + 1e-9), py = Math.floor((row.y_m_localTM - y0 + half) / coarseScaleM + 1e-9);
      var pi = map[px + '_' + py];
      if (pi === undefined) { fc.scale = { parent_index: null, score_coarse: null, delta: null, consistency: 'n/a' }; noPair++; continue; }
      var cc = coarse.cells[pi];
      if (fc.status !== 'scored' || cc.status !== 'scored') {
        fc.scale = { parent_index: pi, score_coarse: cc.status === 'scored' ? cc.score : null, delta: null, consistency: 'n/a' };
        noPair++;
      } else {
        var d = fc.score - cc.score;
        var cons = Math.abs(d) <= cfg.scaleAgreementTolerance ? 'consistent' : 'divergent';
        fc.scale = { parent_index: pi, score_coarse: cc.score, delta: d, consistency: cons };
        deltas.push(d);
        if (cons === 'consistent') consistent++; else divergent++;
        (children[pi] = children[pi] || []).push(fc.score);
      }
    }
    // parent-level comparison: mean of child (120 m) scores vs the parent's own 360 m score
    var pa = [], pb = [], parents = Object.keys(children);
    parents.forEach(function (k) {
      var arr = children[k], m = arr.reduce(function (a, b) { return a + b; }, 0) / arr.length;
      var cc = coarse.cells[+k];
      if (cc.status === 'scored') { pa.push(m); pb.push(cc.score); }
    });
    var absd = deltas.map(Math.abs).sort(function (a, b) { return a - b; });
    var res = {
      fine_scale_m: fineScaleM, coarse_scale_m: coarseScaleM, tolerance_points: cfg.scaleAgreementTolerance,
      n_fine_pairs: deltas.length, n_fine_unpaired: noPair, n_consistent: consistent, n_divergent: divergent,
      fraction_consistent: deltas.length ? consistent / deltas.length : null,
      mean_delta: deltas.length ? deltas.reduce(function (a, b) { return a + b; }, 0) / deltas.length : null,
      median_abs_delta: quantile(absd, 0.5), p90_abs_delta: quantile(absd, 0.9),
      n_parent_pairs: pa.length,
      spearman_parent_childmean_vs_coarse: spearman(pa, pb),
      pearson_parent_childmean_vs_coarse: pearson(pa, pb)
    };
    // top-fraction overlap, at the coarse-cell level
    var frac = cfg.topFractionForOverlap;
    if (pa.length >= 20) {
      var keep = Math.max(1, Math.ceil(pa.length * frac));
      var order = function (arr) { return arr.map(function (v, i) { return i; }).sort(function (a, b) { return (arr[b] - arr[a]) || (a - b); }).slice(0, keep); };
      var A = new Set(order(pa)), B = order(pb), inter = 0;
      B.forEach(function (i) { if (A.has(i)) inter++; });
      res.top_fraction_overlap = { fraction: frac, k: keep, intersection: inter, jaccard: inter / (2 * keep - inter) };
    }
    return res;
  }

  // ------------------------------------------------------------------ confidence
  /**
   * confidence:
   *   high         all feature weight present AND the 360 m parent agrees within tolerance
   *   medium       completeness >= confidenceMediumMinCompleteness and (scale consistent, or scale not assessable);
   *                or complete data but scale divergent
   *   low          scored, but anything weaker (partial data below the medium level, or partial AND divergent)
   *   insufficient not scored
   * "scale not assessable" (no 360 m score for the parent) counts as medium at best, never high.
   */
  function assignConfidence(cell, cfg) {
    if (cell.status !== 'scored') return 'insufficient';
    var cons = cell.scale ? cell.scale.consistency : 'n/a';
    var complete = cell.completeness >= 1 - 1e-12;
    if (complete && cons === 'consistent') return 'high';
    if (complete) return 'medium';                                  // complete but divergent or unassessable
    if (cell.completeness >= cfg.confidenceMediumMinCompleteness && cons === 'consistent') return 'medium';
    return 'low';
  }

  // ------------------------------------------------------------------ candidates
  /**
   * Ranked, spatially separated candidate list (greedy non-maximum suppression on the ranked cells).
   * Only cells with completeness >= candidateMinCompleteness are eligible.
   */
  function selectCandidates(table, rows, ref, cfg) {
    var picked = [], i, minD2 = cfg.minSeparationM * cfg.minSeparationM;
    for (i = 0; i < table.ranked.length && picked.length < cfg.topN; i++) {
      var c = table.ranked[i];
      if (c.completeness < cfg.candidateMinCompleteness - 1e-12) continue;
      var ok = true;
      for (var j = 0; j < picked.length; j++) {
        var dx = c.x - picked[j].x, dy = c.y - picked[j].y;
        if (dx * dx + dy * dy < minD2) { ok = false; break; }
      }
      if (ok) picked.push(c);
    }
    return picked.map(function (c, k) { return candidateRecord(c, k + 1, ref, cfg); });
  }

  function candidateRecord(c, candidateRank, ref, cfg) {
    var feats = {};
    cfg.features.forEach(function (f) {
      var ft = c.features[f], fe = ref.features[f];
      feats[f] = {
        value: ft.value, reference_center: round(fe.center, 4), reference_model: fe.model, z: round(ft.z, 3), percentile_in_reference: round(ft.percentile, 4), score: round(ft.score, 2),
        weight: round(ft.weight, 4), effective_weight: round(ft.effective_weight, 4), contribution: round(ft.contribution, 2),
        shortfall: round(ft.shortfall, 2), outside_reference_range: ft.outside_ref_range
      };
    });
    return {
      candidate_rank: candidateRank, cell_rank: c.rank, lon_deg: c.lon, lat_deg: c.lat, x_m_localTM: c.x, y_m_localTM: c.y,
      score: round(c.score, 2), confidence: c.confidence, completeness: round(c.completeness, 3), n_features_used: c.n_features_used,
      limiting_feature: c.limiting_feature, n_outside_ref_range: c.n_outside_ref_range,
      scale_check: c.scale ? { score_360m: round(c.scale.score_coarse, 2), delta_120m_minus_360m: round(c.scale.delta, 2), consistency: c.scale.consistency } : null,
      features: feats,
      status_label: 'Terrain-metric similarity candidate. Not a confirmed analog.'
    };
  }

  // ------------------------------------------------------------------ analysis driver
  function requireInput(inputs, body, scale) {
    var b = inputs && inputs[body], s = b && (b[scale] || b[String(scale)]);
    if (!s || !Array.isArray(s.rows) || !s.summary) throw new Error('Missing input: ' + body + ' ' + scale + ' m needs { rows, summary }.');
    var need = ['x_m_localTM', 'y_m_localTM', 'lon_deg', 'lat_deg'].concat(ALLOWED_FEATURES);
    if (body === 'earth' && s.rows.length) {
      need.forEach(function (c) { if (!(c in s.rows[0])) throw new Error('Earth ' + scale + ' m rows lack column "' + c + '".'); });
    }
    return s;
  }

  /**
   * Full analysis.
   *   inputs = { earth: {120:{rows,summary}, 360:{...}}, mars: {120:{summary}, 360:{summary}}, moon: {...} }
   * Mars/Moon only need `summary` (the model never reads their cells; they are used by validation only).
   * Returns { model, config, references, results, candidates, scale_comparison }.
   */
  function analyze(inputs, userConfig) {
    var cfg = resolveConfig(userConfig);
    var P = cfg.primaryScaleM, S = cfg.sensitivityScaleM;
    var out = {
      model: { name: MODEL_NAME, version: VERSION, label: MODEL_LABEL, disclaimer: DISCLAIMER },
      config: cfg, references: {}, results: {}, candidates: {}, scale_comparison: {}, inputs_meta: {}
    };
    var earth = { 120: requireInput(inputs, 'earth', P), 360: requireInput(inputs, 'earth', S) };
    out.inputs_meta.earth = {};
    [P, S].forEach(function (sc) {
      var s = earth[sc === P ? 120 : 360];
      out.inputs_meta.earth[sc] = { n_rows: s.rows.length, summary_n_cells: s.summary.grid ? s.summary.grid.cells : null, source: s.summary.provenance ? s.summary.provenance.dataset : null, source_sha256: s.summary.provenance ? s.summary.provenance.source_sha256 : null };
    });
    ['mars', 'moon'].forEach(function (body) {
      out.references[body] = {}; out.results[body] = {}; out.candidates[body] = {};
      var tables = {};
      [P, S].forEach(function (sc) {
        var refIn = inputs[body] && (inputs[body][sc] || inputs[body][String(sc)]);
        if (!refIn || !refIn.summary) throw new Error('Missing reference summary: ' + body + ' ' + sc + ' m.');
        if (refIn.summary.scale_m !== sc) throw new Error('Reference summary for ' + body + ' says scale_m=' + refIn.summary.scale_m + ', expected ' + sc + '.');
        var ref = buildReference(refIn.summary, cfg);
        out.references[body][sc] = ref;
        var er = earth[sc === P ? 120 : 360];
        if (er.summary.scale_m !== sc) throw new Error('Earth summary scale_m=' + er.summary.scale_m + ', expected ' + sc + '.');
        tables[sc] = scoreTable(er.rows, ref, cfg);
      });
      out.scale_comparison[body] = compareScales(tables[P], tables[S], P, S, earth[120].rows, earth[360].rows, cfg);
      [P, S].forEach(function (sc) {
        var t = tables[sc];
        if (sc === S) t.cells.forEach(function (c) { c.scale = null; });      // 360 m cells do not carry a parent
        t.cells.forEach(function (c) { c.confidence = assignConfidence(c, cfg); });
        out.results[body][sc] = t;
      });
      var rows = { 120: earth[120].rows, 360: earth[360].rows };
      out.candidates[body] = {
        primary: selectCandidates(tables[P], rows[120], out.references[body][P], cfg),
        sensitivity: selectCandidates(tables[S], rows[360], out.references[body][S], cfg)
      };
      // for the sensitivity list there is no coarser parent; give each its score at 120 m (mean of child scores) for cross reading
      var kids = {};
      tables[P].cells.forEach(function (c) { if (c.scale && c.scale.parent_index !== null && c.status === 'scored') (kids[c.scale.parent_index] = kids[c.scale.parent_index] || []).push(c.score); });
      out.candidates[body].sensitivity.forEach(function (cand) {
        var idx = tables[S].cells.findIndex(function (c) { return c.rank === cand.cell_rank; });
        var arr = kids[idx];
        cand.scale_check = { mean_120m_child_score: arr ? round(arr.reduce(function (a, b) { return a + b; }, 0) / arr.length, 2) : null, n_120m_children_scored: arr ? arr.length : 0 };
      });
      // is each primary candidate's parent in the top fraction of 360 m scores?
      var keepK = Math.max(1, Math.ceil(tables[S].ranked.length * cfg.topFractionForOverlap));
      out.candidates[body].primary.forEach(function (cand) {
        var cell = tables[P].ranked[cand.cell_rank - 1];
        var parent = cell.scale && cell.scale.parent_index !== null ? tables[S].cells[cell.scale.parent_index] : null;
        cand.scale_check.parent_rank_360m = parent && parent.rank ? parent.rank : null;
        cand.scale_check.parent_in_top_fraction_360m = parent && parent.rank ? parent.rank <= keepK : null;
      });
    });
    return out;
  }

  /** Browser convenience: analyze FieldZeroData.data (after loadAll of the terrain csv + summary datasets). */
  function analyzeLoaded(data, userConfig) {
    var inputs = {};
    ['earth', 'mars', 'moon'].forEach(function (b) {
      inputs[b] = {};
      [120, 360].forEach(function (sc) {
        var t = data && data.terrain && data.terrain[b] && data.terrain[b][String(sc)];
        if (!t || !t.summary) throw new Error('FieldZeroData: ' + b + ' ' + sc + ' m summary is not loaded.');
        if (b === 'earth' && (!t.csv || !t.csv.rows)) throw new Error('FieldZeroData: earth ' + sc + ' m csv is not loaded.');
        inputs[b][sc] = { rows: t.csv ? t.csv.rows : null, summary: t.summary };
      });
    });
    return analyze(inputs, userConfig);
  }

  // ------------------------------------------------------------------ GeoJSON (primary 120 m cells, all of them)
  function configForMetadata(cfg) {
    return { features: cfg.features, weights_normalised: cfg.weights, distribution: cfg.distribution, lognormalIfNegativeMassAbove: cfg.lognormalIfNegativeMassAbove, minWeightCompleteness: cfg.minWeightCompleteness, minFeatures: cfg.minFeatures, scaleAgreementTolerance: cfg.scaleAgreementTolerance, confidenceMediumMinCompleteness: cfg.confidenceMediumMinCompleteness };
  }
  function referenceForMetadata(ref, cfg) {
    var o = { body: ref.body, site: ref.site, scale_m: ref.scale_m, source: ref.source, features: {} };
    cfg.features.forEach(function (f) {
      var r = ref.features[f];
      o.features[f] = { n: r.n, mean: r.mean, std: r.std, min: r.min, max: r.max, model: r.model, center: round(r.center, 6), log_mu: r.model === 'lognormal' ? round(r.mu, 6) : null, log_sigma: r.model === 'lognormal' ? round(r.sigma, 6) : null, beta_alpha: r.model === 'beta' ? round(r.alpha, 6) : null, beta_beta: r.model === 'beta' ? round(r.beta, 6) : null, gaussian_negative_mass: round(r.gaussian_negative_mass, 4) };
    });
    return o;
  }

  /**
   * GeoJSON FeatureCollection with one Point per Earth 120 m cell (scored or not). Foreign member "metadata" carries
   * the label, disclaimer, formulas, weights and reference statistics. Cells that cannot be scored have score null.
   */
  function toGeoJSON(analysis, body) {
    var cfg = analysis.config, P = cfg.primaryScaleM;
    var table = analysis.results[body][P], ref = analysis.references[body][P];
    var features = new Array(table.cells.length);
    table.cells.forEach(function (c, i) {
      var p = {
        rank: c.rank, score: round(c.score, 2), confidence: c.confidence, completeness: round(c.completeness, 3),
        n_features_used: c.n_features_used, limiting_feature: c.limiting_feature, n_outside_ref_range: c.status === 'scored' ? c.n_outside_ref_range : null
      };
      cfg.features.forEach(function (f) { p['fs_' + f] = round(c.features[f].score, 1); });
      cfg.features.forEach(function (f) { p['c_' + f] = round(c.features[f].contribution, 2); });
      p.score_360m = c.scale ? round(c.scale.score_coarse, 2) : null;
      p.delta_360m = c.scale ? round(c.scale.delta, 2) : null;
      p.scale_consistency = c.scale ? c.scale.consistency : 'n/a';
      features[i] = { type: 'Feature', geometry: { type: 'Point', coordinates: [c.lon, c.lat] }, properties: p };
    });
    return {
      type: 'FeatureCollection',
      metadata: {
        title: 'FIELD//ZERO Earth Western Desert terrain similarity to ' + (body === 'mars' ? 'Mars (Jezero)' : 'Moon (Taurus-Littrow)') + ' reference terrain, ' + P + ' m',
        model: analysis.model, scale_m: P, target_body: body, reference_site: ref.site, coordinate_note: 'Point = WGS84 lon/lat degrees of the Earth cell centre. Feature order equals the row order of the 120 m terrain CSV.',
        score_definition: {
          feature_score: '100 * (1 - |2F - 1|) where F is the percentile of the Earth cell value under the reference model built from the summary JSON (lognormal or Beta[min,max]; Gaussian only if forced). For z-score models this equals 100 * erfc(|z| / sqrt(2)).',
          overall_score: 'sum_i(w_i * s_i) / sum_i(w_i) over available features; weights renormalised per cell.',
          contribution: 'c_i = (w_i / W_available) * s_i; contributions sum to score (to rounding).',
          property_prefixes: { fs_: 'feature score (0-100, 1 decimal)', c_: 'contribution in overall points (2 decimals)' },
          omitted_per_cell: 'z-scores and x/y are not stored per cell to keep the file small; z-scores are in top_candidates.json for candidates, and x/y are in the input CSV (same row order as this file).',
          null_meaning: 'score is null where fewer than minFeatures features or less than minWeightCompleteness of the weight were available.',
          rank: '1 = highest overall score among scored cells at this scale; null if not scored.',
          scale_properties: 'score_360m is the overall score of the 360 m parent cell against the 360 m reference; delta_360m = score - score_360m.'
        },
        config: configForMetadata(cfg), reference: referenceForMetadata(ref, cfg),
        inputs: analysis.inputs_meta.earth, stats: analysis.results[body][P].stats
      },
      features: features
    };
  }

  /** top_candidates.json content. */
  function toTopCandidates(analysis) {
    var cfg = analysis.config;
    var o = {
      model: analysis.model, config: configForMetadata(cfg),
      candidate_rules: { topN: cfg.topN, minSeparationM: cfg.minSeparationM, candidateMinCompleteness: cfg.candidateMinCompleteness, selection: 'Cells ranked by overall score; greedy selection skipping any cell closer than minSeparationM to an already selected candidate. Distance is Euclidean in local transverse-Mercator metres.' },
      search_domain: 'Only the Earth Western Desert terrain window present in the processed datasets (not all of Earth, not all of the Western Desert).',
      inputs: analysis.inputs_meta.earth, targets: {}
    };
    ['mars', 'moon'].forEach(function (b) {
      o.targets[b] = {
        reference: { 120: referenceForMetadata(analysis.references[b][120], cfg), 360: referenceForMetadata(analysis.references[b][360], cfg) },
        stats_120m: analysis.results[b][120].stats, stats_360m: analysis.results[b][360].stats,
        scale_comparison: analysis.scale_comparison[b],
        candidates_120m: analysis.candidates[b].primary,
        sensitivity_candidates_360m: analysis.candidates[b].sensitivity
      };
    });
    return o;
  }

  return {
    version: VERSION, MODEL_NAME: MODEL_NAME, MODEL_LABEL: MODEL_LABEL, DISCLAIMER: DISCLAIMER,
    ALLOWED_FEATURES: ALLOWED_FEATURES, FORBIDDEN_FEATURES: FORBIDDEN_FEATURES, FEATURE_INFO: FEATURE_INFO, DEFAULT_CONFIG: DEFAULT_CONFIG,
    resolveConfig: resolveConfig, buildReference: buildReference, scoreFeature: scoreFeature, scoreCell: scoreCell, scoreTable: scoreTable,
    compareScales: compareScales, assignConfidence: assignConfidence, selectCandidates: selectCandidates,
    analyze: analyze, analyzeLoaded: analyzeLoaded, toGeoJSON: toGeoJSON, toTopCandidates: toTopCandidates,
    util: { erfc: erfc, normCdf: normCdf, betaTails: betaTails, lgamma: lgamma, spearman: spearman, pearson: pearson, averageRanks: averageRanks, quantile: quantile, round: round }
  };
});
