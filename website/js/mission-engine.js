/*!
 * FIELD//ZERO Mission Intelligence & Planning Engine  (v1.0.0)
 *
 *   TERRAIN ANALOG + PLANNING MODEL. Similarity = four DEM-derived metrics only. Suitability and risk are
 *   heuristic indices. Route time and energy are ESTIMATES from assumptions and placeholders.
 *   Nothing here is a confirmed analog, a measurement, or a flight-readiness assessment.
 *
 * WHAT THIS FILE DOES
 *   1. Analog intelligence   assessDomain(target)           what the data say about Earth-vs-target terrain
 *   2. Site assessment       assessSite(location, opts)     one location -> five separate sections
 *   3. Site selection        rankSites(opts)                strategy-weighted ranking + separated selection
 *   4. Route planning        planRoute(opts)                terrain-aware A* / tour on the real DEM grid
 *   5. Strategy optimization optimize(config)               FAST vs SAFE vs SCIENTIFIC, scored and compared
 *   6. Exports               exportSimulationScenario(), sampleRoute(), toGeoJSON(), summarize()
 *
 * FIVE SEPARATE OUTPUTS (never merged into one number), at every level (domain, site, route, plan, mission):
 *   similarity | suitability | risk | confidence | data_limitations
 *
 * REUSE (nothing below duplicates a working module)
 *   FieldZeroData        loads datasets (this file only asks it to load extra terrain CSVs on demand)
 *   FieldZeroSimilarity  ALL similarity scores, ranks, per-feature explanations, scale checks, candidates.
 *                        This engine never recomputes a similarity score.
 *   FieldZeroIntel       evidence gaps (and, optionally, the baseline diversity portfolio for comparison)
 *   FieldZeroMissionModel  configuration, validation, constraints, limitation registry (mission-model.js)
 *
 * NEVER FABRICATED
 *   Every coordinate returned is the centre of a real terrain-grid cell (row_index into the project CSV).
 *   No value is interpolated into the data. Cells with missing terrain metrics are unknown terrain and are
 *   blocked, never assumed safe. Rover parameters are placeholders unless the user supplies them, and every
 *   output that depends on them is tagged `estimate`.
 *
 * DETERMINISTIC: no randomness, ties break on the lowest CSV row index, outputs are plain JSON.
 *
 * Works in browsers and Node 18+.
 *   <script src="js/data-loader.js"></script> <script src="js/similarity-engine.js"></script>
 *   <script src="js/mission-intelligence.js"></script> <script src="js/mission-model.js"></script>
 *   <script src="js/mission-engine.js"></script>
 *   const engine = FieldZeroMission.fromFZ(window.FZ);            // reuses app.js analysis, rows and data
 *   const out = engine.run({ targetBody: 'mars', strategy: 'ALL' });   // never throws: { ok, plan, errors, warnings }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.FieldZeroMission = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function (G) {
  'use strict';

  var VERSION = '1.0.0';
  var RAD2DEG = 180 / Math.PI;
  var DEG2RAD = Math.PI / 180;

  // ------------------------------------------------------------------ errors and small helpers
  function MissionError(code, message, details) {
    var e = new Error(message);
    e.name = 'MissionError'; e.code = code;
    e.hint = (details && details.hint) || null;
    e.details = (details && details.details) || null;
    return e;
  }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function round(v, d) { if (!isNum(v)) return null; var f = Math.pow(10, d == null ? 2 : d); return Math.round(v * f) / f; }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function mean(a) { if (!a.length) return null; var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return s / a.length; }
  function quantileSorted(sorted, q) {
    if (!sorted.length) return null;
    var p = (sorted.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (p - lo);
  }
  /** JSON round trip: guarantees plain JSON (non-finite numbers become null, undefined is dropped). */
  function finalize(o) { return o === undefined ? undefined : JSON.parse(JSON.stringify(o)); }
  function dep(over, key, globalName, file) {
    if (over && over[key]) return over[key];
    if (G && G[globalName]) return G[globalName];
    if (typeof require === 'function') { try { return require(file); } catch (e) { return null; } }
    return null;
  }

  // binary min-heap on (key, value)
  function Heap() { this.k = []; this.v = []; }
  Heap.prototype.push = function (key, val) {
    var k = this.k, v = this.v, i = k.length, p;
    k.push(key); v.push(val);
    while (i > 0) { p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
    k[i] = key; v[i] = val;
  };
  Heap.prototype.pop = function () {
    var k = this.k, v = this.v, n = k.length;
    if (!n) return -1;
    var top = v[0], lk = k.pop(), lv = v.pop();
    n--;
    if (n > 0) {
      var i = 0, l, r, c;
      for (;;) {
        l = 2 * i + 1; if (l >= n) break;
        r = l + 1; c = (r < n && k[r] < k[l]) ? r : l;
        if (k[c] >= lk) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  };
  Heap.prototype.size = function () { return this.k.length; };

  // summed-area table over a Uint8 mask; window sums in O(1)
  function buildSat(mask, nx, ny) {
    var w = nx + 1, S = new Int32Array(w * (ny + 1)), x, y, row;
    for (y = 0; y < ny; y++) {
      row = 0;
      for (x = 0; x < nx; x++) { row += mask[x + y * nx]; S[(y + 1) * w + (x + 1)] = S[y * w + (x + 1)] + row; }
    }
    return S;
  }
  function winSum(S, nx, ny, ix, iy, r) {
    var w = nx + 1, x1 = ix - r < 0 ? 0 : ix - r, x2 = ix + r > nx - 1 ? nx - 1 : ix + r;
    var y1 = iy - r < 0 ? 0 : iy - r, y2 = iy + r > ny - 1 ? ny - 1 : iy + r;
    return S[(y2 + 1) * w + (x2 + 1)] - S[y1 * w + (x2 + 1)] - S[(y2 + 1) * w + x1] + S[y1 * w + x1];
  }

  // ==================================================================================================
  //  ENGINE FACTORY
  // ==================================================================================================
  /**
   * options:
   *   data        FieldZeroData.data (terrain, climate ...). Optional if `analysis` and `rows` are given.
   *   analysis    result of FieldZeroSimilarity.analyze*(). If omitted it is computed once from `data`.
   *   rows        Earth 120 m terrain rows (same table, same order as the analysis). Default: data.terrain.earth[120].csv.rows
   *   terrainRows { mars: {120: rows}, ... } extra terrain tables (otherwise read from data or loaded on demand)
   *   similarityConfig  passed to FieldZeroSimilarity only when this engine computes the analysis itself
   *   mission     default raw mission configuration
   *   deps        { similarity, intel, model, loader } overrides (testing)
   *   includeTimestamp  add meta.generated_utc (off by default so outputs are reproducible)
   *   onProgress  function ({stage, detail}) called during optimize()
   */
  function create(options) {
    options = Object.assign({}, options || {});
    var M = dep(options.deps, 'model', 'FieldZeroMissionModel', './mission-model.js');
    var S = dep(options.deps, 'similarity', 'FieldZeroSimilarity', './similarity-engine.js');
    var I = dep(options.deps, 'intel', 'FieldZeroIntel', './mission-intelligence.js');
    var Loader = (options.deps && options.deps.loader) || (G && G.FieldZeroData) || null;
    if (!M) throw MissionError('MISSING_DEPENDENCY', 'FieldZeroMissionModel (mission-model.js) is not loaded.', { hint: 'Load js/mission-model.js before js/mission-engine.js.' });
    if (!S) throw MissionError('MISSING_DEPENDENCY', 'FieldZeroSimilarity (similarity-engine.js) is not loaded.', { hint: 'Load js/similarity-engine.js first. This engine reuses it and does not re-implement similarity.' });
    if (S.ALLOWED_FEATURES.join() !== M.FEATURE_COLUMNS.join()) {
      throw MissionError('FEATURE_MISMATCH', 'mission-model.js FEATURE_COLUMNS (' + M.FEATURE_COLUMNS.join(',') + ') differ from FieldZeroSimilarity.ALLOWED_FEATURES (' + S.ALLOWED_FEATURES.join(',') + ').', { hint: 'Update mission-model.js to match the similarity engine.' });
    }
    var D = options.data || (Loader && Loader.data) || null;
    var FEATS = S.ALLOWED_FEATURES;
    var state = { analysis: options.analysis || null, grids: {}, fields: {}, gaps: undefined, domain: {} };
    var BODIES = M.BODIES;

    function progress(stage, detail) { if (typeof options.onProgress === 'function') { try { options.onProgress({ stage: stage, detail: detail || null }); } catch (e) { /* UI callback errors must not break planning */ } } }

    // ---------------------------------------------------------------- inputs
    function getRows(body, scale) {
      var t = options.terrainRows && options.terrainRows[body] && (options.terrainRows[body][scale] || options.terrainRows[body][String(scale)]);
      if (t) return t;
      if (body === 'earth' && scale === 120 && options.rows) return options.rows;
      var d = D && D.terrain && D.terrain[body] && D.terrain[body][String(scale)];
      if (d && d.csv && d.csv.rows) return d.csv.rows;
      throw MissionError('TERRAIN_NOT_LOADED', 'Terrain table for ' + body + ' at ' + scale + ' m is not loaded.', {
        hint: "await engine.ensureTerrain('" + body + "', " + scale + ") or FieldZeroData.load('" + body + '_' + scale + "m_terrain_csv'). These CSVs are loaded on demand."
      });
    }
    /** Promise: make sure the terrain CSV for body/scale is available (uses FieldZeroData when needed). */
    function ensureTerrain(body, scale) {
      try { getRows(body, scale); return Promise.resolve(true); } catch (e) { if (e.code !== 'TERRAIN_NOT_LOADED') return Promise.reject(e); }
      if (!Loader || typeof Loader.load !== 'function') return Promise.reject(MissionError('TERRAIN_NOT_LOADED', 'Terrain for ' + body + ' ' + scale + ' m is not loaded and no FieldZeroData loader is available.', { hint: 'Pass options.terrainRows or load the CSV first.' }));
      return Loader.load(body + '_' + scale + 'm_terrain_csv').then(function (r) {
        if (!r.ok) throw MissionError('TERRAIN_NOT_LOADED', 'Could not load ' + body + ' ' + scale + ' m terrain: ' + (r.error && r.error.message), { details: r.error });
        D = D || Loader.data; return true;
      });
    }
    function getAnalysis() {
      if (state.analysis) return state.analysis;
      if (!D) throw MissionError('NO_ANALYSIS', 'No similarity analysis available.', { hint: 'Pass options.analysis (FieldZeroSimilarity.analyze result) or options.data (FieldZeroData.data).' });
      progress('similarity', 'Scoring Earth cells with FieldZeroSimilarity');
      state.analysis = S.analyzeLoaded(D, options.similarityConfig);
      return state.analysis;
    }
    function checkedAnalysis() {
      var a = getAnalysis();
      var chk = M.checkAnalysisShape(a, getRows('earth', 120).length);
      if (!chk.ok) throw MissionError('ANALYSIS_MISMATCH', chk.errors.map(function (e) { return e.message; }).join(' '), { details: chk.errors });
      return a;
    }
    function getGaps() {
      if (state.gaps !== undefined) return state.gaps;
      state.gaps = (I && D && typeof I.evidenceGaps === 'function') ? I.evidenceGaps(D) : null;
      return state.gaps;
    }
    function resolveMission(raw) {
      var v = M.validateMissionConfig(raw === undefined ? (options.mission || {}) : raw);
      if (!v.valid) throw MissionError('INVALID_CONFIG', 'Invalid mission configuration: ' + v.errors.map(function (e) { return e.path + ' (' + e.code + '): ' + e.message; }).join(' | '), { details: v.errors });
      return v;
    }
    function stratOf(id) {
      var s = id === 'BASE' || id === undefined || id === null ? M.BASE_STRATEGY : M.STRATEGIES[id];
      if (!s) throw MissionError('UNKNOWN_STRATEGY', 'Unknown strategy "' + id + '". Use BASE, FAST, SAFE or SCIENTIFIC.');
      return s;
    }

    // ---------------------------------------------------------------- terrain grid
    function getGrid(body, scale) {
      var key = body + '|' + scale;
      if (state.grids[key]) return state.grids[key];
      var rows = getRows(body, scale);
      var v = M.validateTerrainRows(rows, scale, body);
      if (!v.ok) throw MissionError('TERRAIN_INVALID', 'Terrain table ' + body + ' ' + scale + ' m cannot be used: ' + v.errors.map(function (e) { return e.message; }).join(' '), { details: v.errors });
      var g = v.grid, n = g.nx * g.ny, i, k;
      var grid = {
        body: body, scale: scale, nx: g.nx, ny: g.ny, x0: g.x0, y0: g.y0, n: n, rows: rows, nRows: rows.length, warnings: v.warnings,
        rowOf: new Int32Array(n).fill(-1), cellOfRow: new Int32Array(rows.length).fill(-1),
        elev: new Float64Array(n).fill(NaN), slope: new Float64Array(n).fill(NaN), rough: new Float64Array(n).fill(NaN),
        vari: new Float64Array(n).fill(NaN), tri: new Float64Array(n).fill(NaN), known: new Uint8Array(n), nKnown: 0, roughPct: null
      };
      for (i = 0; i < rows.length; i++) {
        var r = rows[i], ix = Math.round((r.x_m_localTM - g.x0) / scale), iy = Math.round((r.y_m_localTM - g.y0) / scale);
        k = ix + iy * g.nx;
        grid.rowOf[k] = i; grid.cellOfRow[i] = k;
        if (isNum(r.elevation)) grid.elev[k] = r.elevation;
        if (isNum(r.slope_deg)) grid.slope[k] = r.slope_deg;
        if (isNum(r.roughness_std)) grid.rough[k] = r.roughness_std;
        if (isNum(r.elev_variability_std)) grid.vari[k] = r.elev_variability_std;
        if (isNum(r.tri)) grid.tri[k] = r.tri;
        if (isNum(r.elevation) && isNum(r.slope_deg) && isNum(r.roughness_std)) { grid.known[k] = 1; grid.nKnown++; }
      }
      // roughness percentile within this grid (relative index; not an absolute measure)
      var sv = [];
      for (k = 0; k < n; k++) if (grid.known[k]) sv.push(grid.rough[k]);
      sv.sort(function (a, b) { return a - b; });
      grid.roughPct = new Float64Array(n).fill(NaN);
      for (k = 0; k < n; k++) {
        if (!grid.known[k]) continue;
        var lo = 0, hi = sv.length, v2 = grid.rough[k];
        while (lo < hi) { var mid = (lo + hi) >> 1; if (sv[mid] <= v2) lo = mid + 1; else hi = mid; }
        grid.roughPct[k] = lo / sv.length;
      }
      state.grids[key] = grid;
      return grid;
    }
    function cellX(grid, k) { return grid.x0 + (k % grid.nx) * grid.scale; }
    function cellY(grid, k) { return grid.y0 + Math.floor(k / grid.nx) * grid.scale; }
    function locRecord(grid, k) {
      var r = grid.rows[grid.rowOf[k]];
      return { row_index: grid.rowOf[k], x_m: r.x_m_localTM, y_m: r.y_m_localTM, lon_deg: r.lon_deg, lat_deg: r.lat_deg, elevation_m: isNum(r.elevation) ? r.elevation : null, coordinate_system: BODIES[grid.body].coordinate_system };
    }

    /** Resolve a user location to a real grid cell. Reports the snap distance; refuses points that are not on the grid. */
    function resolveLocation(loc, grid) {
      var k, snap = 0, method;
      if ('row_index' in loc) {
        if (loc.row_index >= grid.nRows) throw MissionError('LOCATION_OUTSIDE_GRID', 'row_index ' + loc.row_index + ' is beyond the ' + grid.nRows + ' rows of ' + grid.body + ' ' + grid.scale + ' m.');
        k = grid.cellOfRow[loc.row_index]; method = 'row_index';
      } else if ('x_m' in loc) {
        var fx = (loc.x_m - grid.x0) / grid.scale, fy = (loc.y_m - grid.y0) / grid.scale, ix = Math.round(fx), iy = Math.round(fy);
        if (ix < 0 || iy < 0 || ix >= grid.nx || iy >= grid.ny) throw MissionError('LOCATION_OUTSIDE_GRID', 'Point (' + loc.x_m + ', ' + loc.y_m + ') m is outside the ' + grid.body + ' ' + grid.scale + ' m grid.');
        k = ix + iy * grid.nx;
        if (grid.rowOf[k] < 0) throw MissionError('LOCATION_OUTSIDE_GRID', 'No terrain cell exists at that point (grid hole).');
        snap = Math.hypot(loc.x_m - cellX(grid, k), loc.y_m - cellY(grid, k)); method = 'x_y_snapped_to_cell_centre';
      } else {
        var R = BODIES[grid.body].radius_m.value, c = Math.cos(loc.lat_deg * DEG2RAD), best = Infinity, bi = -1, i;
        for (i = 0; i < grid.nRows; i++) {
          var r = grid.rows[i], dx = (r.lon_deg - loc.lon_deg) * DEG2RAD * R * c, dy = (r.lat_deg - loc.lat_deg) * DEG2RAD * R, d = dx * dx + dy * dy;
          if (d < best) { best = d; bi = i; }
        }
        snap = Math.sqrt(best);
        if (bi < 0 || snap > 1.5 * grid.scale) throw MissionError('LOCATION_OUTSIDE_GRID', 'No ' + grid.body + ' ' + grid.scale + ' m terrain cell within 1.5 cells of lon/lat (' + loc.lon_deg + ', ' + loc.lat_deg + '); nearest is ' + round(snap, 0) + ' m away.', { hint: 'For Mars and Moon, lon/lat are body-native sphere coordinates (not WGS84); prefer x_m/y_m or row_index.' });
        k = grid.cellOfRow[bi]; method = 'lon_lat_nearest_cell';
      }
      return { k: k, snap_distance_m: round(snap, 2), method: method };
    }

    // ---------------------------------------------------------------- constraint fields
    function keepOutMask(grid, zones) {
      if (!zones || !zones.length) return null;
      var mask = new Uint8Array(grid.n), z, i;
      zones.forEach(function (zn) {
        if ('x_m' in zn) {
          var cx0 = Math.max(0, Math.floor((zn.x_m - zn.radius_m - grid.x0) / grid.scale)), cx1 = Math.min(grid.nx - 1, Math.ceil((zn.x_m + zn.radius_m - grid.x0) / grid.scale));
          var cy0 = Math.max(0, Math.floor((zn.y_m - zn.radius_m - grid.y0) / grid.scale)), cy1 = Math.min(grid.ny - 1, Math.ceil((zn.y_m + zn.radius_m - grid.y0) / grid.scale));
          for (var iy = cy0; iy <= cy1; iy++) for (var ix = cx0; ix <= cx1; ix++) {
            var dx = grid.x0 + ix * grid.scale - zn.x_m, dy = grid.y0 + iy * grid.scale - zn.y_m;
            if (dx * dx + dy * dy <= zn.radius_m * zn.radius_m) mask[ix + iy * grid.nx] = 1;
          }
        } else {
          var R = BODIES[grid.body].radius_m.value, c = Math.cos(zn.lat_deg * DEG2RAD);
          for (i = 0; i < grid.nRows; i++) {
            var r = grid.rows[i], ddx = (r.lon_deg - zn.lon_deg) * DEG2RAD * R * c, ddy = (r.lat_deg - zn.lat_deg) * DEG2RAD * R;
            if (ddx * ddx + ddy * ddy <= zn.radius_m * zn.radius_m) mask[grid.cellOfRow[i]] = 1;
          }
        }
      });
      return mask;
    }

    /** Per (grid, strategy, constraints) field: passable mask, hazard, window tables. Cached. */
    function getField(grid, strat, cons) {
      var key = [grid.body, grid.scale, strat.id, cons.maxSlopeDeg, cons.maxRoughnessM, cons.neighbourhoodRadiusM, JSON.stringify(cons.keepOut)].join('|');
      if (state.fields[key]) return state.fields[key];
      var n = grid.n, nx = grid.nx, ny = grid.ny, k, i;
      var limU = cons.maxSlopeDeg, limA = limU * strat.route.slopeLimitFactor;
      var rU = cons.maxRoughnessM, rA = rU == null ? null : rU * strat.route.slopeLimitFactor;
      var keep = keepOutMask(grid, cons.keepOut);
      var pass0 = new Uint8Array(n), pass = new Uint8Array(n), hz = new Float64Array(n).fill(NaN), near = new Uint8Array(n);
      var hw = M.RISK.cellHazardWeights, nearFrac = M.RISK.nearLimitFraction;
      for (k = 0; k < n; k++) {
        if (!grid.known[k]) continue;
        var ok = grid.slope[k] <= limA && (rA == null || grid.rough[k] <= rA) && !(keep && keep[k]);
        pass0[k] = ok ? 1 : 0;
        var sh = Math.min(1, Math.pow(grid.slope[k] / limU, 2));
        hz[k] = hw.slope * sh + hw.roughness * grid.roughPct[k];
        near[k] = grid.slope[k] > nearFrac * limU ? 1 : 0;
      }
      var bufCells = strat.route.hazardBufferM > 0 ? Math.ceil(strat.route.hazardBufferM / grid.scale - 1e-9) : 0;
      pass.set(pass0);
      if (bufCells > 0) {
        for (k = 0; k < n; k++) {
          if (pass0[k]) continue;                       // blocked or unknown cell: push the buffer outward
          var bx = k % nx, by = (k / nx) | 0;
          for (var dy = -bufCells; dy <= bufCells; dy++) for (var dx = -bufCells; dx <= bufCells; dx++) {
            var qx = bx + dx, qy = by + dy;
            if (qx >= 0 && qy >= 0 && qx < nx && qy < ny) pass[qx + qy * nx] = 0;
          }
        }
      }
      var known = grid.known;
      var f = {
        key: key, strat: strat, cons: cons, limU: limU, limA: limA, rU: rU, rA: rA, keep: keep, bufCells: bufCells,
        pass: pass, pass0: pass0, hz: hz, near: near,
        satPass: buildSat(pass, nx, ny), satKnown: buildSat(known, nx, ny), satNear: buildSat(near, nx, ny),
        r: Math.max(1, Math.round(cons.neighbourhoodRadiusM / grid.scale)), suit: null, risk: null
      };
      f.win = (2 * f.r + 1) * (2 * f.r + 1);
      state.fields[key] = f;
      return f;
    }
    function frac(sat, grid, fld, k) { return winSum(sat, grid.nx, grid.ny, k % grid.nx, (k / grid.nx) | 0, fld.r) / fld.win; }

    /** Suitability and risk components at one known cell. */
    function cellMetrics(grid, fld, k) {
      if (!grid.known[k]) return null;
      var sw = M.SUITABILITY.weights, rw = M.RISK.weights, slope = grid.slope[k];
      var traffic = frac(fld.satPass, grid, fld, k), cover = frac(fld.satKnown, grid, fld, k), near = frac(fld.satNear, grid, fld, k);
      var margin = 1 - Math.min(1, slope / fld.limA);
      var sc = { trafficability: 100 * traffic, slope_margin: 100 * margin, data_coverage: 100 * cover };
      var rc = { local_slope_hazard: 100 * Math.min(1, Math.pow(slope / fld.limU, 2)), steep_terrain_exposure: 100 * near, roughness_hazard: 100 * grid.roughPct[k], unknown_terrain_exposure: 100 * (1 - cover) };
      var suit = 0, risk = 0, name;
      for (name in sw) suit += sw[name] * sc[name];
      for (name in rw) risk += rw[name] * rc[name];
      return { suit: suit, risk: risk, sc: sc, rc: rc, cover: cover, traffic: traffic };
    }
    function ensureIndex(grid, fld) {
      if (fld.suit) return;
      fld.suit = new Float64Array(grid.n).fill(NaN); fld.risk = new Float64Array(grid.n).fill(NaN);
      for (var k = 0; k < grid.n; k++) { var m = cellMetrics(grid, fld, k); if (m) { fld.suit[k] = m.suit; fld.risk[k] = m.risk; } }
    }
    function blockReason(grid, fld, k) {
      if (!grid.known[k]) return 'terrain_metrics_missing';
      if (grid.slope[k] > fld.limA) return 'slope_above_limit';
      if (fld.rA != null && grid.rough[k] > fld.rA) return 'roughness_above_limit';
      if (fld.keep && fld.keep[k]) return 'inside_keep_out_zone';
      if (!fld.pass[k]) return 'within_hazard_buffer';
      return null;
    }

    // ---------------------------------------------------------------- site assessment sections
    function simCell(target, grid, k) {
      var a = state.analysis;
      if (!a || grid.body !== 'earth') return null;
      var t = a.results[target] && a.results[target][grid.scale];
      if (!t || t.cells.length !== grid.nRows) return null;
      return t.cells[grid.rowOf[k]];
    }
    function similaritySection(target, grid, k) {
      var base = { target: target, basis: 'model_output', engine: S.MODEL_NAME + ' v' + S.version, definition: 'Typicality score 0-100: how close the four terrain metrics are to the reference distribution of the target site. 100 = at the reference median. Not a probability of being an analog.' };
      if (grid.body !== 'earth') return Object.assign(base, { status: 'not_applicable', reason: 'Similarity is computed for Earth cells against the Mars (Jezero) and Moon (Taurus-Littrow) references only.' });
      var c = simCell(target, grid, k);
      if (!c) return Object.assign(base, { status: 'not_available', reason: 'No similarity analysis table matches this grid (' + grid.body + ' ' + grid.scale + ' m).' });
      var a = state.analysis, ref = a.references[target][grid.scale], tab = a.results[target][grid.scale];
      if (c.status !== 'scored') return Object.assign(base, { status: 'not_scored', reason: 'Too few terrain metrics for the similarity model (kernel border cell).', completeness: round(c.completeness, 3), n_features_used: c.n_features_used });
      var feats = {};
      FEATS.forEach(function (f) {
        var ft = c.features[f], fe = ref.features[f];
        feats[f] = { value: ft.value, unit: M.FEATURE_INFO[f].unit, reference_center: round(fe.center, 4), reference_model: fe.model, z: round(ft.z, 3), percentile_in_reference: round(ft.percentile, 4), score: round(ft.score, 2), effective_weight: round(ft.effective_weight, 4), contribution: round(ft.contribution, 2), shortfall: round(ft.shortfall, 2), outside_reference_range: ft.outside_ref_range };
      });
      var other = target === 'mars' ? 'moon' : 'mars', oc = a.results[other] && a.results[other][grid.scale] && a.results[other][grid.scale].cells[grid.rowOf[k]];
      return Object.assign(base, {
        status: 'ok', reference_site: ref.site, scale_m: grid.scale, score: round(c.score, 2), rank: c.rank, n_scored: tab.stats.n_scored, top_percent: round(100 * c.rank / tab.stats.n_scored, 2),
        completeness: round(c.completeness, 3), n_features_used: c.n_features_used, limiting_feature: c.limiting_feature, features: feats,
        scale_check: c.scale ? { score_360m: round(c.scale.score_coarse, 2), delta_120m_minus_360m: round(c.scale.delta, 2), consistency: c.scale.consistency } : null,
        similarity_engine_confidence: c.confidence,
        other_target: oc && oc.status === 'scored' ? { target: other, score: round(oc.score, 2), rank: oc.rank } : null,
        status_label: 'Terrain-metric similarity candidate. Not a confirmed analog.'
      });
    }
    function suitabilitySection(grid, fld, k, m) {
      var base = { basis: 'heuristic', definition: M.SUITABILITY.definition, constraints_applied: M.effectiveConstraints(fld.cons, fld.strat, grid.scale) };
      if (!m) return Object.assign(base, { status: 'not_assessable', index: null, reason: 'Terrain metrics are missing at this cell (unknown terrain).' });
      var comps = {};
      Object.keys(M.SUITABILITY.weights).forEach(function (n) { comps[n] = { value: round(m.sc[n], 1), weight: M.SUITABILITY.weights[n], contribution: round(M.SUITABILITY.weights[n] * m.sc[n], 2), meaning: M.SUITABILITY.components[n] }; });
      return Object.assign(base, { status: 'ok', index: round(m.suit, 2), components: comps, neighbourhood: { radius_m: fld.r * grid.scale, window_cells: fld.win } });
    }
    function riskSection(grid, fld, k, m) {
      var base = { basis: 'heuristic', definition: M.RISK.definition, caution: 'An index for comparing locations, not a probability of failure.' };
      if (!m) return Object.assign(base, { status: 'not_assessable', index: null, class: null, reason: 'Terrain metrics are missing at this cell (unknown terrain).' });
      var comps = {};
      Object.keys(M.RISK.weights).forEach(function (n) { comps[n] = { value: round(m.rc[n], 1), weight: M.RISK.weights[n], contribution: round(M.RISK.weights[n] * m.rc[n], 2), meaning: M.RISK.components[n] }; });
      return Object.assign(base, { status: 'ok', index: round(m.risk, 2), class: M.classifyRisk(m.risk), components: comps, slope_deg: grid.slope[k], slope_limit_user_deg: fld.limU });
    }
    function evidenceCeiling(target) {
      var gaps = getGaps();
      if (target !== 'mars' && target !== 'moon') return { applies: false, missing: [], source: 'n/a' };
      if (gaps) {
        var miss = gaps.items.filter(function (g) { return g.status === 'Missing' && String(g.body).toLowerCase().indexOf(target) !== -1; }).map(function (g) { return g.id; });
        return { applies: miss.length > 0, missing: miss, source: 'FieldZeroIntel.evidenceGaps (derived from the data actually loaded)' };
      }
      var id = target === 'mars' ? 'L_CLIMATE_MARS' : 'L_CLIMATE_MOON';
      return { applies: true, missing: [id], source: 'mission-model limitation registry (project documents); evidence gaps not evaluated because FieldZeroIntel or data is unavailable' };
    }
    function confidenceSection(target, grid, fld, k, m, sim, placeholderRover) {
      var C = M.CONFIDENCE, comps = {}, vals = [];
      function add(name, value, note, state2) { comps[name] = { value: round(value, 3), note: note, state: state2 || null }; vals.push([name, value]); }
      var res = { basis: 'heuristic', definition: C.definition, rule: 'Weakest-link: level is set by the lowest component. A ceiling applies if non-terrain evidence for the target body is missing.' };
      if (!m) return Object.assign(res, { status: 'not_assessable', level: 'insufficient', components: {}, limiting_factor: 'terrain_metrics_missing', ceiling: null });
      if (sim && sim.status === 'ok') {
        var nUsed = sim.n_features_used, nOut = FEATS.filter(function (f) { return sim.features[f].outside_reference_range; }).length;
        add('data_completeness', sim.completeness, 'Share of similarity-feature weight present at this cell.');
        var cons = sim.scale_check ? sim.scale_check.consistency : 'n/a';
        add('scale_consistency', C.scaleConsistencyValue[cons] != null ? C.scaleConsistencyValue[cons] : C.scaleConsistencyValue['n/a'], 'Does the 360 m parent cell give a similar score (within the engine tolerance)?', cons);
        add('reference_coverage', nUsed ? 1 - nOut / nUsed : 0, nOut + ' of ' + nUsed + ' feature value(s) lie outside the observed reference range.');
      } else if (sim && sim.status !== 'not_applicable') {
        add('data_completeness', 0, 'Similarity could not be computed here: ' + (sim.reason || sim.status));
      }
      add('neighbourhood_coverage', m.cover, 'Share of the neighbourhood window with known terrain metrics.');
      var weakest = vals.reduce(function (a, b) { return b[1] < a[1] ? b : a; });
      var level0 = M.confidenceLevel(weakest[1]), ceiling = null, level = level0, limiting = weakest[0];
      var ev = evidenceCeiling(target);
      if (sim && sim.status !== 'not_applicable' && ev.applies) {
        ceiling = { level: C.ceilingWhenEvidenceMissing, reason: 'Non-terrain evidence for ' + target + ' is missing (' + ev.missing.join(', ') + '). Terrain metrics alone cannot support more than this.', source: ev.source };
        var capped = M.minLevel(level0, ceiling.level);
        if (capped !== level0) limiting = 'evidence_ceiling';
        level = capped;
      }
      return Object.assign(res, { status: 'ok', level: level, level_before_ceiling: level0, components: comps, limiting_factor: limiting, ceiling: ceiling, placeholder_vehicle_parameters: !!placeholderRover });
    }
    function siteLimitations(target, grid, m, sim, cfgV) {
      var out = M.limitationsFor({ target: grid.body === 'earth' ? target : null, operating: grid.body, level: 'site', placeholderRover: false });
      function dyn(id, severity, statement, effect, affects) { out.push({ id: id, severity: severity, category: 'location', statement: statement, effect: effect, affects: affects, source: 'computed for this location', basis: 'project_data' }); }
      if (!m) dyn('S_UNKNOWN_TERRAIN', 'major', 'Terrain metrics are missing at this cell.', 'Suitability and risk cannot be assessed and the cell is blocked for routing.', ['suitability', 'risk', 'confidence']);
      if (sim && sim.status === 'ok') {
        if (sim.completeness < 1) dyn('S_PARTIAL_FEATURES', 'minor', 'Only ' + sim.n_features_used + ' of ' + FEATS.length + ' similarity features are present (completeness ' + sim.completeness + ').', 'The score uses renormalised weights on the remaining features.', ['similarity', 'confidence']);
        if (sim.scale_check && sim.scale_check.consistency === 'divergent') dyn('S_SCALE_DIVERGENT', 'major', 'The 360 m parent cell scores ' + sim.scale_check.score_360m + ' versus ' + sim.score + ' at 120 m (difference ' + sim.scale_check.delta_120m_minus_360m + ').', 'The result depends on grid scale, so it is less stable.', ['similarity', 'confidence']);
        var nOut = FEATS.filter(function (f) { return sim.features[f].outside_reference_range; });
        if (nOut.length) dyn('S_OUTSIDE_REFERENCE', 'minor', 'Feature(s) outside the observed reference range: ' + nOut.join(', ') + '.', 'The score is an extrapolation of the reference distribution model.', ['similarity']);
      }
      if (m && m.cover < 1) dyn('S_NEIGHBOURHOOD_UNKNOWN', 'minor', round(100 * (1 - m.cover), 1) + '% of the neighbourhood window has unknown terrain (grid edge or kernel border).', 'Suitability is reduced and risk raised; confidence is limited.', ['suitability', 'risk', 'confidence']);
      if (cfgV && cfgV.uses_placeholder_rover) out = out.concat(M.limitationsFor({ target: null, operating: grid.body, level: 'site', placeholderRover: true }).filter(function (l) { return l.id === 'L_PLACEHOLDER_ROVER'; }));
      var seen = {}; return out.filter(function (l) { if (seen[l.id]) return false; seen[l.id] = true; return true; });
    }
    function eligibility(target, grid, fld, k, cfg, sim) {
      var reasons = [], c = cfg.constraints;
      if (!grid.known[k]) reasons.push('terrain_metrics_missing');
      else { var br = blockReason(grid, fld, k); if (br) reasons.push(br); }
      if (grid.body === 'earth' && sim) {
        if (sim.status !== 'ok') reasons.push('not_scored_by_similarity_model');
        else {
          if (sim.completeness < c.minCompleteness - 1e-12) reasons.push('similarity_completeness_below_minimum');
          if (sim.score < c.minSimilarityScore) reasons.push('similarity_below_minimum');
        }
      }
      return { eligible: reasons.length === 0, reasons: reasons };
    }
    /** Five separate sections for one cell. */
    function buildAssessment(target, grid, fld, k, cfgV) {
      var m = cellMetrics(grid, fld, k);
      var sim = target ? similaritySection(target, grid, k) : { status: 'not_applicable', basis: 'model_output', reason: 'No analog target.' };
      return {
        location: locRecord(grid, k),
        eligibility: eligibility(target, grid, fld, k, cfgV.config, sim),
        similarity: sim,
        suitability: suitabilitySection(grid, fld, k, m),
        risk: riskSection(grid, fld, k, m),
        confidence: confidenceSection(target, grid, fld, k, m, sim, cfgV.uses_placeholder_rover),
        data_limitations: siteLimitations(target, grid, m, sim, cfgV)
      };
    }

    /**
     * Stand-alone assessment of one location.
     * opts: { target:'mars'|'moon', body:'earth'|'mars'|'moon', scale:120|360, strategy:'BASE'|'FAST'|'SAFE'|'SCIENTIFIC', mission }
     * Returns { location, snap, strategy, constraints_applied, eligibility, similarity, suitability, risk, confidence, data_limitations, ... }
     */
    function assessSite(location, opts) {
      opts = opts || {};
      var v = resolveMission(opts.mission), cfg = v.config, body = opts.body || cfg.operatingBody, scale = body === 'earth' ? (opts.scale || M.SITE_SCALE_M) : (opts.scale || cfg.routeScaleM);
      var target = opts.target || cfg.targetBody, strat = stratOf(opts.strategy);
      var lv = M.validateLocation(location, 'location'); if (lv.errors.length) throw MissionError('INVALID_LOCATION', lv.errors.map(function (e) { return e.message; }).join(' '), { details: lv.errors });
      if (body === 'earth') checkedAnalysis();
      var grid = getGrid(body, scale), rl = resolveLocation(lv.location, grid), fld = getField(grid, strat, cfg.constraints);
      var a = buildAssessment(body === 'earth' ? target : null, grid, fld, rl.k, v);
      a.resolved = { snap_distance_m: rl.snap_distance_m, method: rl.method, requested: lv.location };
      a.strategy = strat.id; a.target = body === 'earth' ? target : null; a.body = body; a.scale_m = grid.scale;
      a.meta = meta('site_assessment'); a.label = M.LABEL;
      return finalize(a);
    }

    function meta(kind) {
      var m = { kind: kind, engine_version: VERSION, model_version: M.version, schema_version: M.SCHEMA_VERSION, similarity_engine_version: S.version, deterministic: true };
      if (options.includeTimestamp) m.generated_utc = new Date().toISOString();
      return m;
    }

    // ---------------------------------------------------------------- staging point
    function resolveStaging(v, target) {
      var cfg = v.config, grid = getGrid('earth', 120), cons = cfg.constraints;
      var fields = M.STRATEGY_IDS.map(function (id) { return getField(grid, M.STRATEGIES[id], cons); });
      var okAll = function (k) { return fields.every(function (f) { return f.pass[k]; }); };
      var cells = checkedAnalysis().results[target][120].cells;
      if (cfg.start) {
        var rl = resolveLocation(cfg.start, grid);
        var br = fields.map(function (f) { return blockReason(grid, f, rl.k); }).filter(Boolean);
        if (br.length) throw MissionError('START_BLOCKED', 'The start cell is blocked under the mission constraints (' + br[0] + ').', { hint: 'Choose a start with known terrain and slope below the strictest strategy limit, or relax constraints.maxSlopeDeg.' });
        return { k: rl.k, source: 'user_input', basis: 'user_input', snap_distance_m: rl.snap_distance_m, rationale: 'Start supplied by the user.' };
      }
      var anchor = -1, best = -1, k;
      for (k = 0; k < grid.n; k++) {
        if (!grid.known[k] || !okAll(k)) continue;
        var c = cells[grid.rowOf[k]];
        if (c.status !== 'scored' || c.completeness < cons.minCompleteness - 1e-12) continue;
        if (c.score > best) { best = c.score; anchor = k; }
      }
      if (anchor < 0) throw MissionError('NO_ELIGIBLE_SITES', 'No Earth cell is both scored by the similarity model and passable under every strategy.', { hint: 'Relax constraints.maxSlopeDeg, maxRoughnessM, minCompleteness or keepOut zones.' });
      var R = Math.round(cons.stagingSearchRadiusM / grid.scale), ax = anchor % grid.nx, ay = (anchor / grid.nx) | 0, bestK = anchor, bestRisk = Infinity;
      var idxFld = fields[1];                         // SAFE field: the strictest, used for the proposal so every strategy can start there
      ensureIndex(grid, idxFld);
      for (var dy = -R; dy <= R; dy++) for (var dx = -R; dx <= R; dx++) {
        var qx = ax + dx, qy = ay + dy; if (qx < 0 || qy < 0 || qx >= grid.nx || qy >= grid.ny) continue;
        if (Math.hypot(dx, dy) * grid.scale > cons.stagingSearchRadiusM) continue;
        var q = qx + qy * grid.nx;
        if (!grid.known[q] || !okAll(q)) continue;
        if (frac(idxFld.satKnown, grid, idxFld, q) < 0.999) continue;
        var rk = idxFld.risk[q];
        if (rk < bestRisk - 1e-12 || (Math.abs(rk - bestRisk) <= 1e-12 && q < bestK)) { bestRisk = rk; bestK = q; }
      }
      return { k: bestK, source: 'engine_proposed', basis: 'assumption', snap_distance_m: 0,
        rationale: 'No start was given. Proposed the lowest-risk interior cell (risk index ' + round(bestRisk, 1) + ') within ' + cons.stagingSearchRadiusM + ' m of the highest-scoring eligible cell, passable under all three strategies. This is an assumption; supply `start` to override.' };
    }

    // ---------------------------------------------------------------- site ranking and selection
    function terrainVec(grid, k) { return FEATS.map(function (f) { var v = f === 'slope_deg' ? grid.slope[k] : f === 'roughness_std' ? grid.rough[k] : f === 'elev_variability_std' ? grid.vari[k] : grid.tri[k]; return Math.log(1 + v); }); }

    function rankInternal(v, target, strat, staging, nWanted) {
      var cfg = v.config, cons = cfg.constraints, grid = getGrid('earth', 120), fld = getField(grid, strat, cons), cells = checkedAnalysis().results[target][120].cells;
      ensureIndex(grid, fld);
      var funnel = { total_cells: grid.nRows, known_terrain: 0, scored_by_similarity: 0, complete_features: 0, passable_under_constraints: 0, meets_min_similarity: 0 };
      var elig = [], k;
      for (k = 0; k < grid.n; k++) {
        var i = grid.rowOf[k]; if (i < 0) continue;
        if (!grid.known[k]) continue; funnel.known_terrain++;
        var c = cells[i]; if (c.status !== 'scored') continue; funnel.scored_by_similarity++;
        if (c.completeness < cons.minCompleteness - 1e-12) continue; funnel.complete_features++;
        if (!fld.pass[k]) continue; funnel.passable_under_constraints++;
        if (c.score < cons.minSimilarityScore) continue; funnel.meets_min_similarity++;
        elig.push(k);
      }
      if (!elig.length) return { funnel: funnel, eligible: 0, selected: [], strat: strat, fld: fld };
      var sx = staging ? cellX(grid, staging.k) : 0, sy = staging ? cellY(grid, staging.k) : 0, dref = 0, dist = new Float64Array(elig.length);
      elig.forEach(function (q, j) { var d = Math.hypot(cellX(grid, q) - sx, cellY(grid, q) - sy); dist[j] = d; if (d > dref) dref = d; });
      var W = strat.sites.weights, wsum = W.similarity + W.suitability + W.safety + (staging ? W.proximity : 0);
      var items = elig.map(function (q, j) {
        var sim = cells[grid.rowOf[q]].score, parts = {
          similarity: { value: sim, weight: W.similarity },
          suitability: { value: fld.suit[q], weight: W.suitability },
          safety: { value: 100 - fld.risk[q], weight: W.safety }
        };
        if (staging) parts.proximity = { value: dref > 0 ? 100 * (1 - dist[j] / dref) : 100, weight: W.proximity };
        var comp = 0; for (var n2 in parts) comp += parts[n2].weight * parts[n2].value; comp /= wsum;
        return { k: q, composite: comp, parts: parts, wsum: wsum, dist: dist[j] };
      });
      items.sort(function (a, b) { return (b.composite - a.composite) || (grid.rowOf[a.k] - grid.rowOf[b.k]); });
      var pool = items.slice(0, 3000);
      // terrain-space for the diversity term: log1p of the four metrics, scaled by SD over all eligible cells
      var wd = strat.sites.diversityWeight, V = null;
      if (wd > 0) {
        var vecs = elig.map(function (q) { return terrainVec(grid, q); }), sd = [0, 0, 0, 0], mu = [0, 0, 0, 0], d2;
        vecs.forEach(function (x) { for (d2 = 0; d2 < 4; d2++) mu[d2] += x[d2]; }); for (d2 = 0; d2 < 4; d2++) mu[d2] /= vecs.length;
        vecs.forEach(function (x) { for (d2 = 0; d2 < 4; d2++) sd[d2] += (x[d2] - mu[d2]) * (x[d2] - mu[d2]); });
        for (d2 = 0; d2 < 4; d2++) sd[d2] = Math.sqrt(sd[d2] / vecs.length) || 1;
        V = {}; pool.forEach(function (it) { V[it.k] = terrainVec(grid, it.k).map(function (x, j) { return x / sd[j]; }); });
      }
      var sel = [], minD = cons.minSeparationM;
      while (sel.length < nWanted) {
        var bestIt = null, bestGain = -Infinity, bestDiv = null, bestNear = null;
        for (var p = 0; p < pool.length; p++) {
          var it = pool[p], ok = true, nearest = Infinity, dT = Infinity;
          for (var s = 0; s < sel.length; s++) {
            var md = Math.hypot(cellX(grid, it.k) - cellX(grid, sel[s].k), cellY(grid, it.k) - cellY(grid, sel[s].k));
            if (md < minD) { ok = false; break; }
            if (md < nearest) nearest = md;
            if (V) { var q2 = 0; for (var j2 = 0; j2 < 4; j2++) { var dd = V[it.k][j2] - V[sel[s].k][j2]; q2 += dd * dd; } if (Math.sqrt(q2) < dT) dT = Math.sqrt(q2); }
          }
          if (!ok) continue;
          var div = V && sel.length ? Math.min(1, dT / 1.0) : null;
          var gain = div === null ? it.composite / 100 : (1 - wd) * it.composite / 100 + wd * div;
          if (gain > bestGain + 1e-12) { bestGain = gain; bestIt = it; bestDiv = div; bestNear = isFinite(nearest) ? nearest : null; }
        }
        if (!bestIt) break;
        bestIt.gain = bestGain; bestIt.div = bestDiv; bestIt.nearest = bestNear;
        sel.push(bestIt);
      }
      return { funnel: funnel, eligible: elig.length, pool: pool.length, selected: sel, strat: strat, fld: fld, dref: dref };
    }

    function siteRecord(v, target, grid, fld, it, rankNo, strat, staging) {
      var a = buildAssessment(target, grid, fld, it.k, v), cells = state.analysis.results[target][120].cells, c = cells[grid.rowOf[it.k]];
      var contrib = Object.keys(it.parts).map(function (n) { return { component: n, value: round(it.parts[n].value, 2), weight: round(it.parts[n].weight / it.wsum, 4), contribution: round(it.parts[n].weight * it.parts[n].value / it.wsum, 2) }; });
      var why = (rankNo === 1 ? 'Top-ranked under ' + strat.id + ': ' : 'Rank ' + rankNo + ' under ' + strat.id + ': ') + 'composite ' + round(it.composite, 1) + ' = ' + contrib.map(function (x) { return x.component + ' ' + x.contribution; }).join(' + ') + '. ' +
        'Similarity ' + round(c.score, 1) + ' (cell rank ' + c.rank + '), suitability ' + a.suitability.index + ', risk ' + a.risk.index + ' (' + a.risk.class + '). ' +
        (it.nearest != null ? 'Nearest selected site ' + round(it.nearest / 1000, 2) + ' km away' + (it.div != null ? ', terrain-space distance ' + round(it.div, 2) + ' (1.0 = one SD of Earth terrain variation).' : '.') : 'First pick, no neighbours yet.');
      a.rank = rankNo; a.strategy = strat.id;
      a.composite = { score: round(it.composite, 2), basis: 'heuristic', formula: 'sum(weight_i * component_i) / sum(weight_i), components on 0-100 (safety = 100 - risk index; proximity = 100 * (1 - distance to staging / farthest eligible cell))', breakdown: contrib };
      a.selection = { objective_gain: round(it.gain, 4), distance_to_staging_m: staging ? round(it.dist, 0) : null, nearest_selected_km: it.nearest != null ? round(it.nearest / 1000, 3) : null, terrain_space_distance: it.div != null ? round(it.div, 3) : null, min_separation_m: v.config.constraints.minSeparationM };
      a.why_selected = why; a.status_label = 'Terrain-metric similarity candidate. Not a confirmed analog.';
      return a;
    }

    /**
     * Rank and select sites for one strategy.
     * opts: { target, strategy:'FAST'|'SAFE'|'SCIENTIFIC', n, mission }
     * Returns { strategy, target, staging, funnel, eligible_cells, sites[], reference_similarity_candidates[], ... }
     */
    function rankSites(opts) {
      opts = opts || {};
      var v = resolveMission(opts.mission), cfg = v.config, target = opts.target || cfg.targetBody, strat = stratOf(opts.strategy || 'SAFE');
      if (strat.id === 'BASE') throw MissionError('UNKNOWN_STRATEGY', 'rankSites needs FAST, SAFE or SCIENTIFIC.');
      if (cfg.operatingBody !== 'earth') throw MissionError('NOT_APPLICABLE', 'Similarity-based site selection exists only for Earth cells (operatingBody = earth).');
      var grid = getGrid('earth', 120), staging = opts.staging || resolveStaging(v, target);
      return finalize(rankPackage(v, target, strat, staging, opts.n || cfg.objectives.numSites));
    }
    function rankPackage(v, target, strat, staging, n) {
      var grid = getGrid('earth', 120), r = rankInternal(v, target, strat, staging, n), fld = r.fld;
      var out = {
        strategy: strat.id, target: target, intent: strat.intent, basis: 'assumption',
        constraints_applied: M.effectiveConstraints(v.config.constraints, strat, grid.scale),
        site_weights: strat.sites.weights, diversity_weight: strat.sites.diversityWeight,
        staging: Object.assign(locRecord(grid, staging.k), { source: staging.source, basis: staging.basis, rationale: staging.rationale }),
        selection_funnel: r.funnel, eligible_cells: r.eligible, pool_size: r.pool || 0,
        sites: r.selected.map(function (it, j) { return siteRecord(v, target, grid, fld, it, j + 1, strat, staging); }),
        reference_similarity_candidates: state.analysis.candidates[target].primary.slice(0, 5).map(function (c) { return { candidate_rank: c.candidate_rank, row_x_m: c.x_m_localTM, row_y_m: c.y_m_localTM, lon_deg: c.lon_deg, lat_deg: c.lat_deg, score: c.score, note: 'FieldZeroSimilarity top candidates (similarity only, ignores suitability, risk and strategy). Shown for comparison.' }; }),
        notes: []
      };
      if (!r.selected.length) out.notes.push('No eligible site. Funnel: ' + JSON.stringify(r.funnel) + '. Relax constraints.');
      else if (r.selected.length < n) out.notes.push('Only ' + r.selected.length + ' site(s) fit the ' + v.config.constraints.minSeparationM + ' m separation among ' + r.eligible + ' eligible cells.');
      return out;
    }

    // ---------------------------------------------------------------- route planning
    function costModel(grid, fld, strat, rover, gravity) {
      var rw = strat.route.weights, K = strat.route.riskPenaltyK, minSf = rover.minSpeedFactor, Crr = rover.rollingResistance, limU = fld.limU, limA = fld.limA;
      var wD = rw.distance, wT = rw.time, wE = rw.energy, wR = rw.risk * K, elev = grid.elev, hz = fld.hz;
      var mg = rover.massKg * gravity, eta = rover.drivetrainEfficiency, v0 = rover.nominalSpeedMps, pBase = rover.basePowerW;
      /** Step physics + cost. Returns cost or -1 when the step grade exceeds the applied limit. */
      function edge(a, b, dh, out) {
        var dz = elev[b] - elev[a], d3 = Math.sqrt(dh * dh + dz * dz), gradeDeg = Math.atan(Math.abs(dz) / dh) * RAD2DEG;
        if (gradeDeg > limA) return -1;
        var sf = 1 - (1 - minSf) * Math.min(1, gradeDeg / limU), f = Crr * (dh / d3) + dz / d3; if (f < 0) f = 0;
        var hmean = 0.5 * (hz[a] + hz[b]);
        if (out) { out.d3 = d3; out.grade = gradeDeg; out.sf = sf; out.t = d3 / (v0 * sf); out.mech = mg * f * d3 / eta; out.hz = hmean; out.dz = dz; }
        return d3 * (wD + wT / sf + wE * (f / Crr) + wR * hmean);
      }
      return { edge: edge, lb: wD + wT, weights: { distance: wD, time: wT, energy: wE, risk: rw.risk, riskPenaltyK: K }, mg: mg, eta: eta, v0: v0, pBase: pBase, minSf: minSf, Crr: Crr };
    }
    var NB = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    /** Dijkstra / A*. goals = array of cell indices; A* heuristic only when exactly one goal. */
    function search(grid, fld, cm, src, goals) {
      var n = grid.n, nx = grid.nx, ny = grid.ny, sc = grid.scale, pass = fld.pass;
      var dist = new Float64Array(n).fill(Infinity), parent = new Int32Array(n).fill(-1), closed = new Uint8Array(n), heap = new Heap();
      var isGoal = new Uint8Array(n), remaining = 0, g;
      for (g = 0; g < goals.length; g++) if (!isGoal[goals[g]] && goals[g] !== src) { isGoal[goals[g]] = 1; remaining++; }
      var astar = goals.length === 1, gx = 0, gy = 0, lb = cm.lb;
      if (astar) { gx = goals[0] % nx; gy = (goals[0] / nx) | 0; }
      dist[src] = 0; heap.push(0, src);
      if (remaining === 0) return { dist: dist, parent: parent, closed: closed };
      var expanded = 0;
      while (heap.size()) {
        var k = heap.pop();
        if (closed[k]) continue;
        closed[k] = 1; expanded++;
        if (isGoal[k]) { remaining--; if (remaining === 0) break; }
        var ix = k % nx, iy = (k / nx) | 0, dk = dist[k];
        for (var m = 0; m < 8; m++) {
          var dx = NB[m][0], dy = NB[m][1], qx = ix + dx, qy = iy + dy;
          if (qx < 0 || qy < 0 || qx >= nx || qy >= ny) continue;
          var b = qx + qy * nx;
          if (!pass[b] || closed[b]) continue;
          if (dx !== 0 && dy !== 0 && (!pass[ix + dx + iy * nx] || !pass[ix + (iy + dy) * nx])) continue;   // no corner cutting
          var c = cm.edge(k, b, (dx !== 0 && dy !== 0) ? sc * Math.SQRT2 : sc);
          if (c < 0) continue;
          var nd = dk + c;
          if (nd < dist[b]) { dist[b] = nd; parent[b] = k; heap.push(astar ? nd + lb * Math.hypot(qx - gx, qy - gy) * sc : nd, b); }
        }
      }
      return { dist: dist, parent: parent, closed: closed, expanded: expanded };
    }
    function tracePath(parent, src, dst) {
      var p = [dst], k = dst, guard = 0;
      while (k !== src && guard++ < 5e6) { k = parent[k]; if (k < 0) return null; p.push(k); }
      return p.reverse();
    }
    function componentSize(grid, fld, src) {
      var seen = new Uint8Array(grid.n), q = [src], head = 0, nx = grid.nx, ny = grid.ny; seen[src] = 1;
      while (head < q.length) {
        var k = q[head++], ix = k % nx, iy = (k / nx) | 0;
        for (var m = 0; m < 8; m++) {
          var dx = NB[m][0], dy = NB[m][1], qx = ix + dx, qy = iy + dy; if (qx < 0 || qy < 0 || qx >= nx || qy >= ny) continue;
          var b = qx + qy * nx; if (seen[b] || !fld.pass[b]) continue;
          if (dx !== 0 && dy !== 0 && (!fld.pass[ix + dx + iy * nx] || !fld.pass[ix + (iy + dy) * nx])) continue;
          seen[b] = 1; q.push(b);
        }
      }
      var total = 0; for (var i = 0; i < grid.n; i++) total += fld.pass[i];
      return { reachable_cells: q.length, passable_cells: total, seen: seen };
    }

    /** Physics and hazard totals along a cell path. All time/energy values are ESTIMATES. */
    function pathMetrics(grid, fld, cm, path, simTable) {
      var seg = { from: [], to: [], horizontal_m: [], length_m: [], grade_deg: [], est_time_s: [], est_energy_wh: [], hazard: [] };
      var prof = { distance_m: [0], elevation_m: [grid.elev[path[0]]], cell_slope_deg: [grid.slope[path[0]]], hazard: [fld.hz[path[0]]] };
      var o = {}, sc = grid.scale, tot = { d3: 0, dh: 0, t: 0, mech: 0, up: 0, down: 0, hexp: 0 }, grades = [], slopes = [grid.slope[path[0]]], hmax = fld.hz[path[0]], hs = [fld.hz[path[0]]], nNear = fld.near[path[0]] ? 1 : 0, turns = 0, lastDir = null, cum = 0;
      var nx = grid.nx, simSum = 0, simN = 0;
      if (simTable) { var s0 = simTable.cells[grid.rowOf[path[0]]]; if (s0 && s0.status === 'scored') { simSum += s0.score; simN++; } }
      for (var i = 1; i < path.length; i++) {
        var a = path[i - 1], b = path[i], dx = (b % nx) - (a % nx), dy = ((b / nx) | 0) - ((a / nx) | 0), dh = (dx !== 0 && dy !== 0) ? sc * Math.SQRT2 : sc;
        var c = cm.edge(a, b, dh, o);
        if (c < 0) throw MissionError('PATH_INVALID', 'Path step ' + i + ' exceeds the applied slope limit.');
        var tEdge = o.t, eWh = (o.mech + cm.pBase * tEdge) / 3600;
        seg.from.push(grid.rowOf[a]); seg.to.push(grid.rowOf[b]); seg.horizontal_m.push(round(dh, 2)); seg.length_m.push(round(o.d3, 2)); seg.grade_deg.push(round(o.grade, 3)); seg.est_time_s.push(round(tEdge, 2)); seg.est_energy_wh.push(round(eWh, 4)); seg.hazard.push(round(o.hz, 4));
        cum += o.d3; prof.distance_m.push(round(cum, 2)); prof.elevation_m.push(grid.elev[b]); prof.cell_slope_deg.push(grid.slope[b]); prof.hazard.push(round(fld.hz[b], 4));
        tot.d3 += o.d3; tot.dh += dh; tot.t += tEdge; tot.mech += o.mech; tot.hexp += o.hz * o.d3; if (o.dz > 0) tot.up += o.dz; else tot.down -= o.dz;
        grades.push(o.grade); slopes.push(grid.slope[b]); hs.push(fld.hz[b]); if (fld.hz[b] > hmax) hmax = fld.hz[b]; if (fld.near[b]) nNear++;
        var dir = dx + ',' + dy; if (lastDir !== null && dir !== lastDir) turns++; lastDir = dir;
        if (simTable) { var sc2 = simTable.cells[grid.rowOf[b]]; if (sc2 && sc2.status === 'scored') { simSum += sc2.score; simN++; } }
      }
      var sortedSlopes = slopes.slice().sort(function (x, y) { return x - y; });
      var meanH = tot.d3 > 0 ? tot.hexp / tot.d3 : hs[0], energyWh = (tot.mech + cm.pBase * tot.t) / 3600;
      var straight = Math.hypot(cellX(grid, path[path.length - 1]) - cellX(grid, path[0]), cellY(grid, path[path.length - 1]) - cellY(grid, path[0]));
      var riskIdx = 100 * (0.6 * meanH + 0.4 * hmax);
      return {
        seg: seg, prof: prof, cells: path,
        metrics: {
          distance_m: round(tot.d3, 1), horizontal_distance_m: round(tot.dh, 1), straight_line_m: round(straight, 1), detour_ratio: straight > 0 ? round(tot.dh / straight, 3) : null,
          est_drive_time_h: round(tot.t / 3600, 3), est_energy_wh: round(energyWh, 2), elevation_gain_m: round(tot.up, 1), elevation_loss_m: round(tot.down, 1),
          max_travel_grade_deg: round(Math.max.apply(null, grades.length ? grades : [0]), 2), mean_travel_grade_deg: round(mean(grades) || 0, 2),
          max_cell_slope_deg: round(sortedSlopes[sortedSlopes.length - 1], 2), p95_cell_slope_deg: round(quantileSorted(sortedSlopes, 0.95), 2),
          mean_hazard: round(meanH, 4), max_hazard: round(hmax, 4), hazard_exposure_m: round(tot.hexp, 1), share_cells_near_slope_limit: round(nNear / path.length, 4),
          route_risk_index: round(riskIdx, 2), route_risk_class: M.classifyRisk(riskIdx), n_cells: path.length, n_turns: turns,
          mean_similarity_along_route: simN ? round(simSum / simN, 2) : null
        },
        raw: { time_s: tot.t, energy_wh: energyWh, d3: tot.d3, hazard_mean: meanH, hazard_max: hmax, risk_index: riskIdx }
      };
    }

    function waypointList(grid, cells) {
      var out = [], nx = grid.nx, i;
      for (i = 0; i < cells.length; i++) {
        var kind = null;
        if (i === 0) kind = 'start';
        else if (i === cells.length - 1) kind = 'end';
        else {
          var dx = (cells[i] % nx) - (cells[i - 1] % nx), dy = ((cells[i] / nx) | 0) - ((cells[i - 1] / nx) | 0), dir = dx + ',' + dy;
          var ndx = (cells[i + 1] % nx) - (cells[i] % nx), ndy = ((cells[i + 1] / nx) | 0) - ((cells[i] / nx) | 0);
          if (dir !== ndx + ',' + ndy) kind = 'turn';
        }
        if (kind) out.push({ idx: i, kind: kind });
      }
      return out;
    }

    /** Build one route result: single goal (A*) or ordered tour (Dijkstra matrix + exact order for <= 6 stops). */
    function routeCore(v, strat, bodyName, scale, startLoc, goalLocs, opts) {
      var cfg = v.config, grid = getGrid(bodyName, scale), cons = cfg.constraints, fld = getField(grid, strat, cons);
      var roverV = cfg.rover, g = BODIES[bodyName].gravity.value, cm = costModel(grid, fld, strat, roverV, g);
      var simT = (bodyName === 'earth' && state.analysis && state.analysis.results[cfg.targetBody] && state.analysis.results[cfg.targetBody][scale] && state.analysis.results[cfg.targetBody][scale].cells.length === grid.nRows) ? state.analysis.results[cfg.targetBody][scale] : null;
      var res = { status: 'ok', strategy: strat.id, body: bodyName, scale_m: scale, coordinate_system: BODIES[bodyName].coordinate_system, basis: 'estimate' };
      var s = resolveLocation(startLoc, grid);
      var sBlock = blockReason(grid, fld, s.k);
      if (sBlock) throw MissionError('START_BLOCKED', 'Start cell is blocked under ' + strat.id + ' constraints (' + sBlock + ').', { hint: 'Slope limit applied: ' + round(fld.limA, 2) + ' deg (' + strat.id + ' = ' + strat.route.slopeLimitFactor + ' x user limit).' });
      var goals = [], dropped = [];
      goalLocs.forEach(function (gl, j) {
        var r = resolveLocation(gl, grid), br = blockReason(grid, fld, r.k);
        if (br) { dropped.push({ index: j, row_index: grid.rowOf[r.k], reason: br, detail: 'Goal cell is blocked under ' + strat.id + ' constraints.' }); return; }
        if (r.k === s.k) { dropped.push({ index: j, row_index: grid.rowOf[r.k], reason: 'same_as_start', detail: 'Goal is the start cell.' }); return; }
        if (goals.some(function (x) { return x.k === r.k; })) { dropped.push({ index: j, row_index: grid.rowOf[r.k], reason: 'duplicate', detail: 'Goal repeats an earlier goal.' }); return; }
        goals.push({ k: r.k, snap: r.snap_distance_m, srcIndex: j });
      });
      res.start = Object.assign(locRecord(grid, s.k), { snap_distance_m: s.snap_distance_m });
      res.dropped_goals = dropped;
      res.constraints_applied = M.effectiveConstraints(cons, strat, scale);
      res.cost_model = {
        basis: 'heuristic', formula: 'step cost = d3 * ( w_distance + w_time / speedFactor + w_energy * energyFactor + w_risk * K * hazard ), with 8-connected steps, no corner cutting, hard limit on step grade and cell slope.',
        weights: cm.weights, speed_factor: 'speedFactor = 1 - (1 - ' + cm.minSf + ') * min(1, grade / user slope limit)', energy_factor: 'max(0, Crr*cos(t) + sin(t)) / Crr (no regeneration on descents)',
        hazard: 'h = ' + M.RISK.cellHazardWeights.slope + ' * min(1,(slope/limit)^2) + ' + M.RISK.cellHazardWeights.roughness + ' * roughness percentile in this grid',
        heuristic_for_a_star: 'euclidean horizontal distance * (w_distance + w_time): admissible and consistent',
        unknown_terrain: 'blocked (never assumed safe)', gravity: Object.assign({ body: bodyName }, BODIES[bodyName].gravity)
      };
      if (!goals.length) { res.status = 'no_route'; res.reason = 'no_valid_goal'; res.explanation = ['No goal cell is usable: ' + (dropped.length ? dropped.map(function (d) { return d.reason; }).join(', ') : 'no goal given') + '.']; return { res: res, grid: grid }; }

      // order the goals
      var nodes = [s.k].concat(goals.map(function (x) { return x.k; })), searches = [], unreachable = [], order = [];
      if (goals.length === 1) {
        var sr = search(grid, fld, cm, s.k, [goals[0].k]);
        if (!isFinite(sr.dist[goals[0].k])) {
          var comp = componentSize(grid, fld, s.k);
          res.status = 'no_route'; res.reason = 'goal_unreachable';
          res.diagnostics = { start_component_cells: comp.reachable_cells, passable_cells_total: comp.passable_cells, share_of_passable_reachable: round(comp.reachable_cells / Math.max(1, comp.passable_cells), 4), slope_limit_applied_deg: round(fld.limA, 2), hazard_buffer_cells: fld.bufCells };
          res.explanation = ['The goal cannot be reached from the start under ' + strat.id + ' constraints. The start connects to ' + comp.reachable_cells + ' of ' + comp.passable_cells + ' passable cells. Relax the slope limit, remove keep-out zones, or choose another goal.'];
          return { res: res, grid: grid };
        }
        searches = [sr]; order = [0];
      } else {
        var C = [], sIdx;
        for (sIdx = 0; sIdx < nodes.length; sIdx++) {
          var targets = nodes.filter(function (_, j) { return j !== sIdx; });
          searches.push(search(grid, fld, cm, nodes[sIdx], targets));
        }
        goals = goals.filter(function (gx2, j) { var ok = isFinite(searches[0].dist[gx2.k]); if (!ok) unreachable.push({ row_index: grid.rowOf[gx2.k], reason: 'unreachable_from_start' }); return ok; });
        // rebuild after removing unreachable goals
        var keepIdx = [0]; nodes.forEach(function (nk, j) { if (j > 0 && goals.some(function (x) { return x.k === nk; })) keepIdx.push(j); });
        if (goals.length === 0) { res.status = 'no_route'; res.reason = 'goal_unreachable'; res.unreachable_goals = unreachable; res.explanation = ['None of the goals can be reached from the start under ' + strat.id + ' constraints.']; return { res: res, grid: grid }; }
        var m = keepIdx.length, cost = function (a, b) { return searches[keepIdx[a]].dist[nodes[keepIdx[b]]]; };
        var best = { c: Infinity, o: null }, perm = [], used = new Uint8Array(m);
        (function rec(last, acc) {
          if (acc >= best.c) return;
          if (perm.length === m - 1) { var tot = acc + (opts.returnToStart ? cost(last, 0) : 0); if (tot < best.c) { best.c = tot; best.o = perm.slice(); } return; }
          for (var j = 1; j < m; j++) if (!used[j]) { used[j] = 1; perm.push(j); rec(j, acc + cost(last, j)); perm.pop(); used[j] = 0; }
        })(0, 0);
        order = best.o.map(function (j) { return j - 1; });
        goals = best.o.map(function (j) { return goals[j - 1]; });
        // build leg list with source search indices
        var legs = [], prev = 0;
        best.o.forEach(function (j) { legs.push({ from: nodes[keepIdx[prev]], to: nodes[keepIdx[j]], si: keepIdx[prev] }); prev = j; });
        if (opts.returnToStart) legs.push({ from: nodes[keepIdx[prev]], to: s.k, si: keepIdx[prev] });
        res.__legs = legs; res.unreachable_goals = unreachable;
      }
      var legsFinal = res.__legs || [{ from: s.k, to: goals[0].k, si: 0 }];
      delete res.__legs;
      var full = [], legSummaries = [], sumRaw = { time_s: 0, energy_wh: 0, d3: 0 }, perLeg = [];
      legsFinal.forEach(function (lg, li) {
        var p = tracePath(searches[lg.si].parent, lg.from, lg.to);
        if (!p) throw MissionError('PATH_INVALID', 'Internal error: leg ' + li + ' could not be traced.');
        perLeg.push(p);
        full = full.concat(li === 0 ? p : p.slice(1));
      });
      var pm = pathMetrics(grid, fld, cm, full, simT);
      // per-leg metrics (distance/time/energy) from the same physics
      var cursor = 0;
      perLeg.forEach(function (p, li) {
        var lm = pathMetrics(grid, fld, cm, p, simT).metrics;
        legSummaries.push({ leg: li + 1, from_row_index: grid.rowOf[p[0]], to_row_index: grid.rowOf[p[p.length - 1]], distance_m: lm.distance_m, est_drive_time_h: lm.est_drive_time_h, est_energy_wh: lm.est_energy_wh, max_travel_grade_deg: lm.max_travel_grade_deg, route_risk_index: lm.route_risk_index });
        cursor += p.length - 1;
      });
      res.goals = goals.map(function (x) { return Object.assign(locRecord(grid, x.k), { snap_distance_m: x.snap }); });
      res.visit_order = goals.map(function (x) { return grid.rowOf[x.k]; });
      res.return_to_start = !!opts.returnToStart;
      res.legs = legSummaries;
      res.path = { row_indices: full.map(function (k) { return grid.rowOf[k]; }), x_m: full.map(function (k) { return cellX(grid, k); }), y_m: full.map(function (k) { return cellY(grid, k); }), lon_deg: full.map(function (k) { return grid.rows[grid.rowOf[k]].lon_deg; }), lat_deg: full.map(function (k) { return grid.rows[grid.rowOf[k]].lat_deg; }), elevation_m: pm.prof.elevation_m };
      var wps = waypointList(grid, full), stopSet = {}; goals.forEach(function (x) { stopSet[x.k] = true; });
      var marked = {}; wps.forEach(function (w) { marked[w.idx] = w; });
      full.forEach(function (k, i) { if (stopSet[k] && i > 0 && !(opts.returnToStart && i === full.length - 1 && k === s.k)) { marked[i] = { idx: i, kind: 'stop' }; } });
      if (opts.returnToStart) marked[full.length - 1] = { idx: full.length - 1, kind: 'end' };
      res.waypoints = Object.keys(marked).map(Number).sort(function (a, b) { return a - b; }).map(function (i, j) {
        return Object.assign({ id: 'wp' + j, kind: marked[i].kind, path_index: i, distance_along_m: pm.prof.distance_m[i] }, locRecord(grid, full[i]));
      });
      res.profile = pm.prof; res.segments = pm.seg; res.metrics = pm.metrics;
      res.metrics_basis = { distance_m: 'estimate (3-D length between cell centres; sub-cell relief not resolved)', est_drive_time_h: 'estimate', est_energy_wh: 'estimate', route_risk_index: 'heuristic', mean_similarity_along_route: 'model_output', elevation_gain_m: 'project_data (cell elevations, own datum)' };
      res.__raw = pm.raw;
      return { res: res, grid: grid, fld: fld, cm: cm };
    }

    function routeConfidence(v, grid, res) {
      var geom = 'medium', est = v.uses_placeholder_rover ? 'low' : 'medium', notes = [];
      notes.push('Path geometry: every step uses known terrain; confidence is capped at medium because ' + grid.scale + ' m cells do not resolve obstacles.');
      notes.push(v.uses_placeholder_rover ? 'Time and energy: vehicle parameters are placeholders (' + v.placeholder_rover_params.join(', ') + '), so estimates are low confidence.' : 'Time and energy: user-supplied vehicle parameters, but the cost model is generic; capped at medium.');
      if (res.dropped_goals && res.dropped_goals.length) notes.push(res.dropped_goals.length + ' goal(s) dropped (see dropped_goals).');
      return { basis: 'heuristic', definition: M.CONFIDENCE.definition, status: 'ok', level: M.minLevel(geom, est), components: { path_geometry: { level: geom }, time_energy_estimates: { level: est } }, limiting_factor: v.uses_placeholder_rover ? 'placeholder_vehicle_parameters' : 'generic_cost_model_and_cell_resolution', ceiling: null, notes: notes };
    }
    function feasibility(v, totalDriveH, totalWh, distM, nSites) {
      var r = v.config.resources, dwell = v.config.objectives.siteDwellH, rover = v.config.rover;
      var timeReq = totalDriveH + nSites * dwell, energyReq = totalWh + rover.basePowerW * nSites * dwell, usable = r.energyBudgetWh == null ? null : r.energyBudgetWh * (1 - r.energyReserveFraction);
      function chk(req, budget, unit) { return budget == null ? { status: 'not_evaluated', required: round(req, 2), budget: null, unit: unit, margin_fraction: null } : { status: req <= budget + 1e-9 ? 'within' : 'exceeds', required: round(req, 2), budget: round(budget, 2), unit: unit, margin_fraction: round((budget - req) / budget, 4) }; }
      var f = { basis: 'estimate', time: chk(timeReq, r.timeBudgetH, 'h'), energy: chk(energyReq, usable, 'Wh (usable = budget x (1 - reserve))'), distance: chk(distM, r.maxTotalDistanceM, 'm'), total_time_h: round(timeReq, 3), total_energy_wh: round(energyReq, 2), site_dwell_h_each: dwell, n_sites_visited: nSites };
      var ev = [f.time, f.energy, f.distance].filter(function (x) { return x.status !== 'not_evaluated'; });
      f.feasible = ev.length ? ev.every(function (x) { return x.status === 'within'; }) : null;
      f.note = ev.length ? 'Feasibility covers only the budgets the user supplied.' : 'No budget supplied: feasibility not evaluated.';
      return f;
    }
    function routeExplanation(strat, res, grid) {
      var m = res.metrics, L = [];
      L.push(strat.id + ' route over ' + grid.body + ' terrain at ' + grid.scale + ' m: ' + m.n_cells + ' cells, ' + m.distance_m + ' m (straight line ' + m.straight_line_m + ' m, detour ' + m.detour_ratio + ').');
      L.push('Estimated ' + m.est_drive_time_h + ' h driving and ' + m.est_energy_wh + ' Wh (ESTIMATES from ' + (res.vehicle_is_placeholder ? 'placeholder' : 'user-supplied') + ' vehicle parameters).');
      L.push('Hard limits: step grade and cell slope <= ' + res.constraints_applied.slope_limit_applied_deg + ' deg (' + strat.route.slopeLimitFactor + ' x user ' + res.constraints_applied.slope_limit_user_deg + ' deg)' + (res.constraints_applied.hazard_buffer_cells ? ', ' + res.constraints_applied.hazard_buffer_cells + '-cell buffer around blocked or unknown cells' : '') + '; unknown terrain is blocked.');
      L.push('Steepest travel grade ' + m.max_travel_grade_deg + ' deg, steepest cell slope ' + m.max_cell_slope_deg + ' deg, route risk index ' + m.route_risk_index + ' (' + m.route_risk_class + ', heuristic).');
      L.push('Cost weights: ' + JSON.stringify(res.cost_model.weights) + '. ' + strat.intent);
      return L;
    }

    /**
     * Plan a route on real terrain cells.
     * opts: { mission, strategy:'BASE'|'FAST'|'SAFE'|'SCIENTIFIC', body, scale, start:Location, goal:Location, goals:[Location], returnToStart }
     * One goal -> A*. Several goals -> best visiting order (exact for <= 6 goals), unreachable goals reported.
     * Returns a route object (status 'ok' or 'no_route' with diagnostics). Throws MissionError for unusable input.
     */
    function planRoute(opts) {
      opts = opts || {};
      var v = resolveMission(opts.mission), cfg = v.config, strat = stratOf(opts.strategy || (cfg.strategy === 'ALL' ? 'SAFE' : cfg.strategy));
      var body = opts.body || cfg.operatingBody, scale = opts.scale || cfg.routeScaleM;
      var start = opts.start || cfg.start; if (!start) throw MissionError('START_REQUIRED', 'planRoute needs a start location (opts.start or mission.start).');
      var goals = opts.goals || (opts.goal ? [opts.goal] : (cfg.goal ? [cfg.goal] : cfg.stops));
      if (!goals || !goals.length) throw MissionError('GOAL_REQUIRED', 'planRoute needs a goal or goals.');
      var all = [start].concat(goals), errs = [];
      all.forEach(function (l, i) { var r = M.validateLocation(l, i === 0 ? 'start' : 'goals[' + (i - 1) + ']'); errs = errs.concat(r.errors); });
      if (errs.length) throw MissionError('INVALID_LOCATION', errs.map(function (e) { return e.path + ': ' + e.message; }).join(' '), { details: errs });
      if (body === 'earth') { try { checkedAnalysis(); } catch (e) { if (e.code !== 'NO_ANALYSIS') throw e; } }
      var core = routeCore(v, strat, body, scale, M.validateLocation(start, 'start').location, goals.map(function (g2) { return M.validateLocation(g2, 'goal').location; }), { returnToStart: opts.returnToStart != null ? opts.returnToStart : false });
      return finishRoute(v, strat, core);
    }
    function finishRoute(v, strat, core) {
      var res = core.res, grid = core.grid;
      res.vehicle_is_placeholder = v.uses_placeholder_rover;
      if (res.status === 'ok') {
        res.explanation = routeExplanation(strat, res, grid);
        res.risk = { basis: 'heuristic', definition: 'Hazard-weighted exposure along the path (heuristic, not a failure probability).', status: 'ok', index: res.metrics.route_risk_index, class: res.metrics.route_risk_class, mean_hazard: res.metrics.mean_hazard, max_hazard: res.metrics.max_hazard, hazard_exposure_m: res.metrics.hazard_exposure_m, share_cells_near_slope_limit: res.metrics.share_cells_near_slope_limit, max_cell_slope_deg: res.metrics.max_cell_slope_deg };
        res.confidence = routeConfidence(v, grid, res);
        res.data_limitations = M.limitationsFor({ target: grid.body === 'earth' ? v.config.targetBody : null, operating: grid.body, level: 'route', hasRoute: true, placeholderRover: v.uses_placeholder_rover });
        res.suitability = { basis: 'heuristic', status: 'not_applicable_to_a_path', note: 'Suitability is assessed per site; see the visited sites.' };
        res.similarity = res.metrics.mean_similarity_along_route != null ? { status: 'ok', basis: 'model_output', mean_score_along_route: res.metrics.mean_similarity_along_route, target: v.config.targetBody, note: 'Mean 120 m (or route-scale) similarity score of the cells the path crosses. Context only; similarity is a property of sites, not of a path.' } : { status: 'not_applicable', basis: 'model_output', note: grid.body === 'earth' ? 'Similarity table not available at this scale.' : 'Similarity exists for Earth cells only.' };
        res.raw = res.__raw;
      }
      delete res.__raw;
      return res;
    }

    // ---------------------------------------------------------------- strategy plans
    function sectionRollup(v, target, bodyName, visited, route) {
      var applicable = bodyName === 'earth' && visited.length > 0;
      var scores = visited.map(function (s) { return s.similarity && s.similarity.status === 'ok' ? s.similarity.score : null; }).filter(isNum);
      var suits = visited.map(function (s) { return s.suitability.index; }).filter(isNum), risks = visited.map(function (s) { return s.risk.index; }).filter(isNum);
      var sim = applicable ? { status: scores.length ? 'ok' : 'not_available', basis: 'model_output', target: target, n_sites: visited.length, mean_score: round(mean(scores), 2), min_score: scores.length ? Math.min.apply(null, scores) : null, max_score: scores.length ? Math.max.apply(null, scores) : null, per_site: visited.map(function (s) { return { row_index: s.location.row_index, score: s.similarity.score != null ? s.similarity.score : null, rank: s.similarity.rank != null ? s.similarity.rank : null }; }), route_context: route && route.similarity ? route.similarity : null, note: 'Reused from FieldZeroSimilarity; terrain-metric similarity only.' } : { status: 'not_applicable', basis: 'model_output', reason: bodyName === 'earth' ? 'No sites visited.' : 'Similarity exists for Earth cells only.' };
      var suit = suits.length ? { status: 'ok', basis: 'heuristic', mean_index: round(mean(suits), 2), min_index: round(Math.min.apply(null, suits), 2), per_site: visited.map(function (s) { return s.suitability.index; }) } : { status: 'not_available', basis: 'heuristic' };
      var routeRisk = route && route.status === 'ok' ? route.risk : null, missionRisk = null;
      if (routeRisk && risks.length) missionRisk = 0.5 * routeRisk.index + 0.5 * mean(risks); else if (routeRisk) missionRisk = routeRisk.index; else if (risks.length) missionRisk = mean(risks);
      var risk = { status: missionRisk != null ? 'ok' : 'not_available', basis: 'heuristic', mission_risk_index: round(missionRisk, 2), class: M.classifyRisk(missionRisk), formula: '0.5 * route risk index + 0.5 * mean site risk index (equal split is a heuristic choice)', route: routeRisk, sites: { mean_index: round(mean(risks), 2), max_index: risks.length ? round(Math.max.apply(null, risks), 2) : null, per_site: visited.map(function (s) { return { row_index: s.location.row_index, index: s.risk.index, class: s.risk.class }; }) } };
      var levels = visited.map(function (s) { return s.confidence.level; }).concat(route && route.status === 'ok' ? [route.confidence.level] : []);
      var order = M.CONFIDENCE.levels, lowest = levels.length ? levels.reduce(function (a, b) { return order.indexOf(b) < order.indexOf(a) ? b : a; }) : 'insufficient';
      var conf = { status: levels.length ? 'ok' : 'not_available', basis: 'heuristic', definition: M.CONFIDENCE.definition, level: lowest, rule: 'Lowest level among the visited sites and the route.', site_levels: visited.map(function (s) { return { row_index: s.location.row_index, level: s.confidence.level, limiting_factor: s.confidence.limiting_factor }; }), route: route && route.status === 'ok' ? route.confidence : null };
      var lim = M.limitationsFor({ target: bodyName === 'earth' ? target : null, operating: bodyName, level: 'mission', hasRoute: !!(route && route.status === 'ok'), placeholderRover: v.uses_placeholder_rover });
      var seen = {}; lim.forEach(function (l) { seen[l.id] = true; });
      visited.forEach(function (s) { s.data_limitations.forEach(function (l) { if (!seen[l.id]) { seen[l.id] = true; lim.push(l); } }); });
      var ord = { critical: 0, major: 1, minor: 2 }; lim.sort(function (a, b) { return (ord[a.severity] - ord[b.severity]) || (a.id < b.id ? -1 : 1); });
      return { similarity: sim, suitability: suit, risk: risk, confidence: conf, data_limitations: lim };
    }

    function visitedRecordsFor(v, target, strat, goalSets, siteList, staging) {
      // goalSets: array of resolved 120 m cells k (Earth only)
      var grid = getGrid('earth', 120), fld = getField(grid, strat, v.config.constraints);
      return goalSets.map(function (k, j) {
        var fromList = siteList.filter(function (s) { return s.location.row_index === grid.rowOf[k]; })[0];
        if (fromList) return fromList;
        var a = buildAssessment(target, grid, fld, k, v); a.rank = null; a.strategy = strat.id; a.selection = { source: 'user_goal' }; a.why_selected = 'Supplied by the user as a goal or stop.'; a.status_label = 'User-supplied location. Not a confirmed analog.';
        return a;
      });
    }

    function planStrategy(v, strat, target, staging) {
      var cfg = v.config, body = cfg.operatingBody, scale = cfg.routeScaleM, plan = { strategy: strat.id, label: strat.label, intent: strat.intent, basis: 'assumption', strategy_definition: { route: strat.route, sites: strat.sites }, constraints_applied: M.effectiveConstraints(cfg.constraints, strat, scale), notes: [] };
      var sites = [], goalLocs = [], startLoc, visited = [], ranking = null;
      if (body === 'earth') {
        progress('sites', strat.id + ': ranking sites');
        ranking = rankPackage(v, target, strat, staging, cfg.objectives.numSites);
        sites = ranking.sites; plan.site_selection = { staging: ranking.staging, selection_funnel: ranking.selection_funnel, eligible_cells: ranking.eligible_cells, pool_size: ranking.pool_size, site_weights: ranking.site_weights, diversity_weight: ranking.diversity_weight, reference_similarity_candidates: ranking.reference_similarity_candidates, notes: ranking.notes };
        plan.sites = sites;
        startLoc = { row_index: ranking.staging.row_index };
        var grid120 = getGrid('earth', 120), goalCells = [];
        var wanted = strat.sites.stops === 'one' ? 1 : cfg.objectives.numScienceStops;
        if (strat.sites.stops === 'one' && cfg.goal) goalCells = [resolveLocation(cfg.goal, grid120).k];
        else if (strat.sites.stops !== 'one' && cfg.stops.length) goalCells = cfg.stops.map(function (l) { return resolveLocation(l, grid120).k; });
        else goalCells = sites.slice(0, wanted).map(function (s) { return grid120.cellOfRow[s.location.row_index]; });
        visited = visitedRecordsFor(v, target, strat, goalCells, sites, staging);
        goalLocs = visited.map(function (s) { return { x_m: s.location.x_m, y_m: s.location.y_m }; });
        if (!goalLocs.length) plan.notes.push('No eligible site, so no route was planned.');
      } else {
        startLoc = cfg.start; goalLocs = strat.sites.stops === 'one' ? [cfg.goal || cfg.stops[0]] : (cfg.stops.length ? cfg.stops : [cfg.goal]);
        var gridO = getGrid(body, scale), fldO = getField(gridO, strat, cfg.constraints);
        visited = goalLocs.map(function (l) { var rl = resolveLocation(l, gridO), a = buildAssessment(null, gridO, fldO, rl.k, v); a.rank = null; a.strategy = strat.id; a.why_selected = 'Supplied by the user as a goal or stop.'; return a; });
        plan.sites = [];
      }
      var route = null;
      if (goalLocs.length) {
        progress('route', strat.id + ': planning route');
        var startPlain = M.validateLocation(startLoc, 'start').location || startLoc;
        // on a coarse route grid the 120 m site cell is mapped to the nearest route-grid cell by x/y
        var startForRoute = (body === 'earth' && scale !== 120 && startPlain.row_index != null) ? (function () { var r = getGrid('earth', 120).rows[startPlain.row_index]; return { x_m: r.x_m_localTM, y_m: r.y_m_localTM }; })() : startPlain;
        try {
          route = finishRoute(v, strat, routeCore(v, strat, body, scale, startForRoute, goalLocs, { returnToStart: cfg.objectives.returnToStart && strat.sites.stops !== 'one' }));
        } catch (e) {
          if (e.code !== 'START_BLOCKED' && e.code !== 'LOCATION_OUTSIDE_GRID') throw e;
          route = { status: 'no_route', strategy: strat.id, reason: e.code === 'START_BLOCKED' ? 'start_blocked' : 'location_outside_grid', explanation: [e.message + (e.hint ? ' ' + e.hint : '')] };
        }
      }
      plan.route = route;
      var rollup = sectionRollup(v, target, body, visited, route);
      plan.similarity = rollup.similarity; plan.suitability = rollup.suitability; plan.risk = rollup.risk; plan.confidence = rollup.confidence; plan.data_limitations = rollup.data_limitations;
      var nVis = route && route.status === 'ok' ? route.visit_order.length : 0;
      plan.visited_sites = route && route.status === 'ok' ? route.visit_order.slice() : [];
      if (route && route.status === 'ok') {
        var rawT = route.raw.time_s / 3600, rawE = route.raw.energy_wh;
        plan.resources = feasibility(v, rawT, rawE, route.metrics.distance_m, nVis);
        plan.totals = { distance_m: route.metrics.distance_m, drive_time_h: round(rawT, 3), total_time_h: plan.resources.total_time_h, energy_wh: plan.resources.total_energy_wh, n_sites_visited: nVis, basis: 'estimate' };
      } else {
        plan.resources = { basis: 'estimate', feasible: false, note: route ? 'Route status: ' + route.status + ' (' + route.reason + ').' : 'No route.' };
        plan.totals = null;
        if (route) plan.notes.push('No feasible route: ' + (route.explanation ? route.explanation[0] : route.reason));
      }
      plan.explanation = [strat.intent].concat(route && route.explanation ? route.explanation : []).concat(sites.length ? [sites[0].why_selected] : []);
      return plan;
    }

    // ---------------------------------------------------------------- comparison and recommendation
    function compare(v, plans, sameGoal) {
      var cfg = v.config, pri = cfg.priorities, ids = Object.keys(plans), rows = [], ok = ids.filter(function (id) { return plans[id].totals; });
      var tmin = Math.min.apply(null, ok.map(function (id) { return plans[id].totals.total_time_h; }));
      var sciApplicable = cfg.operatingBody === 'earth';
      ids.forEach(function (id) {
        var p = plans[id], t = p.totals, row = { strategy: id, route_status: p.route ? p.route.status : 'none', feasible: p.resources.feasible, scores: null };
        if (t) {
          var speed = tmin > 0 ? tmin / t.total_time_h : 1, safety = 1 - (p.risk.mission_risk_index || 0) / 100, sim = p.similarity.status === 'ok' ? p.similarity.mean_score : null;
          var science = sciApplicable && sim != null ? (sim / 100) * Math.min(1, t.n_sites_visited / cfg.objectives.numScienceStops) : null;
          var w = { speed: pri.speed, safety: pri.safety, science: science == null ? 0 : pri.science }, ws = w.speed + w.safety + w.science;
          var total = ws > 0 ? (w.speed * speed + w.safety * safety + w.science * (science || 0)) / ws : null;
          row = Object.assign(row, { n_sites_visited: t.n_sites_visited, distance_m: t.distance_m, drive_time_h: t.drive_time_h, total_time_h: t.total_time_h, energy_wh: t.energy_wh, mission_risk_index: p.risk.mission_risk_index, risk_class: p.risk.class, mean_site_similarity: sim, confidence: p.confidence.level, scores: { speed: round(speed, 4), safety: round(safety, 4), science: round(science, 4), total: round(total, 4) } });
        }
        rows.push(row);
      });
      var scored = rows.filter(function (r) { return r.scores; }), feas = scored.filter(function (r) { return r.feasible !== false; });
      function best(arr, key, dir) { if (!arr.length) return null; return arr.reduce(function (a, b) { return (dir * (b[key] - a[key])) < 0 ? b : a; }).strategy; }
      var bestBy = { fastest: best(scored, 'total_time_h', 1), lowest_risk: best(scored, 'mission_risk_index', 1), most_scientific: sciApplicable ? best(scored.filter(function (r) { return r.mean_site_similarity != null; }), 'mean_site_similarity', -1) : null, lowest_energy: best(scored, 'energy_wh', 1) };
      function winner(pv, pool) {
        var w = null, bt = -Infinity;
        pool.forEach(function (r) {
          var s = r.scores, ws = pv.speed + pv.safety + (s.science == null ? 0 : pv.science); if (!(ws > 0)) return;
          var t = (pv.speed * s.speed + pv.safety * s.safety + (s.science == null ? 0 : pv.science * s.science)) / ws;
          if (t > bt + 1e-12) { bt = t; w = r.strategy; }
        });
        return w;
      }
      var rec = { strategy: null, based_on: 'priorities', priorities: pri, feasible_strategies: feas.map(function (r) { return r.strategy; }), rationale: '', caveats: [] };
      if (cfg.strategy !== 'ALL') { rec.strategy = cfg.strategy; rec.based_on = 'user_selected_strategy'; rec.rationale = 'Strategy ' + cfg.strategy + ' was selected by the user; no comparison was requested.'; }
      else if (!feas.length) { rec.rationale = scored.length ? 'No strategy meets the supplied budgets.' : 'No strategy produced a feasible route.'; }
      else {
        feas.sort(function (a, b) { return (b.scores.total - a.scores.total) || (a.strategy < b.strategy ? -1 : 1); });
        var top = feas[0], second = feas[1];
        rec.strategy = top.strategy;
        rec.rationale = top.strategy + ' has the highest weighted score (' + top.scores.total + ') under priorities speed ' + round(pri.speed, 2) + ', safety ' + round(pri.safety, 2) + ', science ' + round(pri.science, 2) + '.' + (second ? ' Next: ' + second.strategy + ' (' + second.scores.total + ').' : '');
        if (second && Math.abs(top.scores.total - second.scores.total) < 0.03) rec.caveats.push('The top two strategies are within 0.03: the choice is sensitive to the priority weights, which are not fitted to data.');
      }
      if (cfg.strategy === 'ALL' && feas.length !== scored.length) rec.caveats.push('Excluded from the recommendation: ' + scored.filter(function (r) { return r.feasible === false; }).map(function (r) { return r.strategy; }).join(', ') + ' (exceed a supplied budget).');
      rec.caveats.push('Scores are heuristic and relative to the strategies compared here; they are not predictions of mission success.');
      if (v.uses_placeholder_rover) rec.caveats.push('Time and energy use placeholder vehicle parameters (' + v.placeholder_rover_params.join(', ') + ').');
      var lastW = {};
      ['speed', 'safety', 'science'].forEach(function (k) { var pv = { speed: 0, safety: 0, science: 0 }; pv[k] = 1; lastW[k] = (k === 'science' && !sciApplicable) ? null : winner(pv, feas.length ? feas : scored); });
      var tradeoffs = [];
      if (plans.FAST && plans.SAFE && plans.FAST.totals && plans.SAFE.totals) {
        var dT = plans.SAFE.totals.total_time_h - plans.FAST.totals.total_time_h, dR = plans.FAST.risk.mission_risk_index - plans.SAFE.risk.mission_risk_index;
        tradeoffs.push('SAFE versus FAST: ' + (dT >= 0 ? '+' : '') + round(dT, 2) + ' h total time for ' + (dR >= 0 ? round(dR, 1) + ' points lower' : round(-dR, 1) + ' points higher') + ' mission risk index (heuristic).');
      }
      if (plans.SCIENTIFIC && plans.FAST && plans.SCIENTIFIC.totals && plans.FAST.totals) tradeoffs.push('SCIENTIFIC versus FAST: visits ' + plans.SCIENTIFIC.totals.n_sites_visited + ' site(s) instead of ' + plans.FAST.totals.n_sites_visited + ' for ' + round(plans.SCIENTIFIC.totals.total_time_h - plans.FAST.totals.total_time_h, 2) + ' h more total time.');
      return {
        table: rows, best_by: bestBy, tradeoffs: tradeoffs, winner_if_only_one_priority_mattered: lastW, recommendation: rec,
        scoring: { basis: 'heuristic', priorities: pri, speed: 'fastest total time among compared strategies / this strategy total time (1 = fastest)', safety: '1 - mission risk index / 100', science: '(mean similarity of visited sites / 100) * min(1, sites visited / numScienceStops); not applicable off Earth', total: 'priority-weighted mean of the applicable scores', note: 'Relative, transparent, and sensitive to the priority weights.' },
        same_goal_routes: sameGoal
      };
    }

    function sameGoalRoutes(v, staging, plans) {
      var cfg = v.config, body = cfg.operatingBody, scale = cfg.routeScaleM, out = { note: 'Each strategy routed from the same start to the same goal, to isolate the effect of the route cost model from the effect of choosing different sites.', goal: null, per_strategy: {} };
      var goalLoc = null;
      if (body === 'earth') {
        var ref = plans.SAFE && plans.SAFE.sites && plans.SAFE.sites[0] || (plans.FAST && plans.FAST.sites && plans.FAST.sites[0]) || (plans.SCIENTIFIC && plans.SCIENTIFIC.sites && plans.SCIENTIFIC.sites[0]);
        goalLoc = cfg.goal ? cfg.goal : (ref ? { x_m: ref.location.x_m, y_m: ref.location.y_m } : null);
        out.goal_source = cfg.goal ? 'user_input' : 'rank-1 site of the most conservative strategy that produced one';
      } else { goalLoc = cfg.goal || cfg.stops[0]; out.goal_source = 'user_input'; }
      if (!goalLoc) { out.note += ' No common goal was available.'; return out; }
      var startLoc = body === 'earth' ? { row_index: staging.row_index } : cfg.start;
      Object.keys(plans).forEach(function (id) {
        try {
          var st = plans[id].strategy ? M.STRATEGIES[id] : null;
          var sl = startLoc;
          if (body === 'earth' && scale !== 120) { var r0 = getGrid('earth', 120).rows[startLoc.row_index]; sl = { x_m: r0.x_m_localTM, y_m: r0.y_m_localTM }; }
          var core = routeCore(v, st, body, scale, sl, [goalLoc], { returnToStart: false }), res = core.res;
          if (res.status !== 'ok') { out.per_strategy[id] = { status: res.status, reason: res.reason }; return; }
          var m = res.metrics;
          if (!out.goal) out.goal = Object.assign({}, res.goals[0]);
          out.per_strategy[id] = { status: 'ok', distance_m: m.distance_m, est_drive_time_h: m.est_drive_time_h, est_energy_wh: m.est_energy_wh, max_travel_grade_deg: m.max_travel_grade_deg, route_risk_index: m.route_risk_index, mean_hazard: m.mean_hazard, n_cells: m.n_cells, basis: 'estimate' };
        } catch (e) { out.per_strategy[id] = { status: 'error', code: e.code || 'ERROR', reason: e.message }; }
      });
      return out;
    }

    // ---------------------------------------------------------------- mission optimisation
    /**
     * Full mission plan. Plans FAST, SAFE and SCIENTIFIC (or one), compares them transparently, and returns
     * the five separate sections for the recommended strategy at the top level.
     * Throws MissionError for unusable input; use run() for a non-throwing wrapper.
     */
    function optimize(rawConfig) {
      var v = resolveMission(rawConfig), cfg = v.config, target = cfg.targetBody, body = cfg.operatingBody;
      progress('validate', 'Configuration valid');
      if (options.similarityConfig === undefined && cfg.similarityConfig && !state.analysis && D) options.similarityConfig = cfg.similarityConfig;
      var warnings = v.warnings.slice();
      if (cfg.similarityConfig && options.analysis) warnings.push({ path: 'similarityConfig', code: 'IGNORED', message: 'similarityConfig is ignored because a precomputed analysis was supplied.' });
      var staging = null;
      if (body === 'earth') { checkedAnalysis(); staging = resolveStaging(v, target); }
      else { getGrid(body, cfg.routeScaleM); }
      var ids = cfg.strategy === 'ALL' ? M.STRATEGY_IDS : [cfg.strategy], plans = {};
      ids.forEach(function (id) { plans[id] = planStrategy(v, M.STRATEGIES[id], target, staging); });
      progress('compare', 'Comparing strategies');
      var same = sameGoalRoutes(v, staging ? { row_index: getGrid('earth', 120).rowOf[staging.k] } : null, plans);
      var comparison = compare(v, plans, same);
      var rec = comparison.recommendation.strategy, recPlan = rec ? plans[rec] : plans[ids[0]];
      var grid = getGrid('earth', 120);
      var out = {
        meta: meta('mission_plan'), label: M.LABEL, disclaimer: 'Terrain-metric analog similarity plus heuristic planning. Time and energy are estimates. No site, route or strategy here is a confirmed analog, a validated plan, or flight-qualified.',
        mission: { config: cfg, defaults_used: v.defaults_used, assumptions: v.assumptions, uses_placeholder_rover: v.uses_placeholder_rover, placeholder_rover_params: v.placeholder_rover_params, vehicle_basis: roverBasis(v), warnings: warnings },
        context: {
          target_body: target, operating_body: body, route_scale_m: cfg.routeScaleM, site_scale_m: M.SITE_SCALE_M,
          coordinate_system: BODIES[body].coordinate_system, wgs84: BODIES[body].wgs84, search_domain: body === 'earth' ? 'Earth Western Desert terrain window present in the processed data only.' : BODIES[body].label + ' reference window present in the processed data only.',
          staging: staging ? Object.assign(locRecord(grid, staging.k), { source: staging.source, basis: staging.basis, rationale: staging.rationale, snap_distance_m: staging.snap_distance_m }) : null,
          gravity: Object.assign({ body: body }, BODIES[body].gravity), strategies_compared: ids
        },
        strategies: plans, comparison: comparison,
        recommended_strategy: rec, source_strategy_for_top_level_sections: recPlan.strategy,
        similarity: recPlan.similarity, suitability: recPlan.suitability, risk: recPlan.risk, confidence: recPlan.confidence, data_limitations: recPlan.data_limitations,
        assumptions_and_estimates: assumptionsList(v, recPlan),
        evidence_gaps: getGaps() ? { counts: getGaps().counts, note: getGaps().note, items: getGaps().items.map(function (g) { return { id: g.id, variable: g.variable, body: g.body, status: g.status, cannot_conclude: g.cannot_conclude }; }) } : null
      };
      progress('done', 'Plan complete');
      return finalize(out);
    }
    function roverBasis(v) {
      var o = {}, d = {}; v.defaults_used.forEach(function (x) { d[x.path] = x.basis; });
      Object.keys(M.SPECS.rover).forEach(function (k) { o[k] = d['rover.' + k] || 'user_input'; });
      return o;
    }
    function assumptionsList(v, plan) {
      var L = v.assumptions.slice();
      L.push('Strategy definitions (slope-limit factors, hazard buffer, cost weights, site-score weights) are design choices [assumption]; see strategies.*.strategy_definition.');
      L.push('Suitability, risk and confidence are heuristic indices with expert-judgement weights [heuristic].');
      L.push('Gravity for energy estimates is an external reference constant, not a project dataset value [external_constant].');
      if (plan.totals) L.push('Route distance, time and energy are ESTIMATES derived from the assumptions above [estimate].');
      return L;
    }
    /** Non-throwing wrapper for UI code: { ok, plan, errors[], warnings[] }. */
    function run(rawConfig) {
      var v = M.validateMissionConfig(rawConfig === undefined ? (options.mission || {}) : rawConfig);
      if (!v.valid) return { ok: false, plan: null, errors: v.errors, warnings: v.warnings };
      try { var plan = optimize(rawConfig); return { ok: true, plan: plan, errors: [], warnings: plan.mission.warnings }; }
      catch (e) { return { ok: false, plan: null, errors: [{ path: '', code: e.code || 'ERROR', message: e.message, hint: e.hint || null }], warnings: v.warnings }; }
    }

    // ---------------------------------------------------------------- analog intelligence (domain level)
    /**
     * What the processed data say about Earth-versus-target terrain, as five separate sections plus findings.
     * opts: { target, mission, includeBaselinePortfolio }
     */
    function assessDomain(opts) {
      opts = opts || {};
      var v = resolveMission(opts.mission), cfg = v.config, target = opts.target || cfg.targetBody;
      if (M.TARGET_BODIES.indexOf(target) === -1) throw MissionError('INVALID_TARGET', 'target must be mars or moon.');
      var a = checkedAnalysis(), grid = getGrid('earth', 120), fld = getField(grid, M.BASE_STRATEGY, cfg.constraints);
      ensureIndex(grid, fld);
      var tab = a.results[target][120], ref = a.references[target][120], cells = tab.cells, st = tab.stats, sc = a.scale_comparison[target];
      var scored = [], ge = { 80: 0, 60: 0, 40: 0 }, limCount = {}, topN = Math.max(1, Math.ceil(st.n_scored * 0.01)), i;
      for (i = 0; i < tab.ranked.length; i++) {
        var c = tab.ranked[i]; scored.push(c.score); [80, 60, 40].forEach(function (t) { if (c.score >= t) ge[t]++; });
        if (i < topN) limCount[c.limiting_feature] = (limCount[c.limiting_feature] || 0) + 1;
      }
      var refFeat = {}, earthMeans = {};
      FEATS.forEach(function (f) {
        var col = f === 'slope_deg' ? grid.slope : f === 'roughness_std' ? grid.rough : f === 'elev_variability_std' ? grid.vari : grid.tri, s = 0, n = 0;
        for (var k = 0; k < grid.n; k++) if (isFinite(col[k])) { s += col[k]; n++; }
        earthMeans[f] = n ? s / n : null;
        var fe = ref.features[f];
        refFeat[f] = { unit: M.FEATURE_INFO[f].unit, reference: { n: fe.n, mean: round(fe.mean, 4), std: round(fe.std, 4), min: round(fe.min, 4), max: round(fe.max, 4), model: fe.model, center: round(fe.center, 4) }, earth_window_mean: round(earthMeans[f], 4), earth_to_reference_mean_ratio: round(earthMeans[f] / fe.mean, 3), basis: 'project_data' };
      });
      var suits = [], risks = [], passN = 0;
      for (i = 0; i < grid.n; i++) if (grid.known[i]) { suits.push(fld.suit[i]); risks.push(fld.risk[i]); passN += fld.pass[i]; }
      suits.sort(function (x, y) { return x - y; }); risks.sort(function (x, y) { return x - y; });
      var ceiling = evidenceCeiling(target), gaps = getGaps();
      var similarity = { status: 'ok', basis: 'model_output', target: target, reference_site: ref.site, scale_m: 120, engine: S.MODEL_NAME + ' v' + S.version, n_scored: st.n_scored, n_cells: st.n_cells, score_distribution: { min: round(st.score.min, 2), p25: round(st.score.p25, 2), median: round(st.score.median, 2), p75: round(st.score.p75, 2), p90: round(st.score.p90, 2), p99: round(st.score.p99, 2), max: round(st.score.max, 2), mean: round(st.score.mean, 2) }, cells_at_or_above: { '80': ge[80], '60': ge[60], '40': ge[40] }, share_at_or_above_80: round(ge[80] / st.n_scored, 4), features: refFeat, limiting_feature_among_top_1_percent: limCount, top_candidates: a.candidates[target].primary.slice(0, 5).map(function (c2) { return { candidate_rank: c2.candidate_rank, lon_deg: c2.lon_deg, lat_deg: c2.lat_deg, x_m_localTM: c2.x_m_localTM, y_m_localTM: c2.y_m_localTM, score: c2.score, confidence: c2.confidence, scale_consistency: c2.scale_check ? c2.scale_check.consistency : null }; }), definition: 'Typicality of Earth terrain metrics against the target reference distribution. Not environmental equivalence.' };
      var suitability = { status: 'ok', basis: 'heuristic', definition: M.SUITABILITY.definition, constraints_applied: M.effectiveConstraints(cfg.constraints, M.BASE_STRATEGY, 120), n_known_cells: grid.nKnown, share_passable_of_known: round(passN / grid.nKnown, 4), index_distribution: { p10: round(quantileSorted(suits, 0.1), 1), median: round(quantileSorted(suits, 0.5), 1), p90: round(quantileSorted(suits, 0.9), 1) } };
      var risk = { status: 'ok', basis: 'heuristic', definition: M.RISK.definition, index_distribution: { p10: round(quantileSorted(risks, 0.1), 1), median: round(quantileSorted(risks, 0.5), 1), p90: round(quantileSorted(risks, 0.9), 1) }, share_high_or_severe: round(risks.filter(function (x) { return x >= 50; }).length / risks.length, 4), note: 'Computed over known Earth cells under the base (user) constraints; relative to this window.' };
      var cscore = sc ? { scale_agreement_fraction_consistent: round(sc.fraction_consistent, 4), parent_spearman: round(sc.spearman_parent_childmean_vs_coarse, 3), median_abs_delta_points: round(sc.median_abs_delta, 2), top5pct_overlap_jaccard: sc.top_fraction_overlap ? round(sc.top_fraction_overlap.jaccard, 3) : null } : null;
      var confidence = { status: 'ok', basis: 'heuristic', definition: M.CONFIDENCE.definition, level: ceiling.applies ? M.minLevel(M.confidenceLevel(sc ? sc.fraction_consistent : 0), M.CONFIDENCE.ceilingWhenEvidenceMissing) : M.confidenceLevel(sc ? sc.fraction_consistent : 0), components: { scale_agreement: cscore, complete_cells_share: round(st.n_complete / st.n_scored, 4), unscored_cells: st.n_insufficient }, ceiling: ceiling.applies ? { level: M.CONFIDENCE.ceilingWhenEvidenceMissing, reason: 'Non-terrain evidence for ' + target + ' is missing (' + ceiling.missing.join(', ') + ').', source: ceiling.source } : null, note: 'Domain-level confidence follows the share of cells whose score agrees across 120 m and 360 m. Site-level confidence uses a weakest-link rule.' };
      var findings = [];
      findings.push(ge[80] + ' of ' + st.n_scored + ' scored Earth cells (' + round(100 * ge[80] / st.n_scored, 2) + '%) score 80 or higher against ' + BODIES[target].label + ' at 120 m. Median score ' + round(st.score.median, 1) + '.');
      FEATS.forEach(function (f) { var r = refFeat[f]; findings.push(M.FEATURE_INFO[f].label + ': Earth window mean ' + r.earth_window_mean + ' ' + r.unit + ' versus reference mean ' + r.reference.mean + ' ' + r.unit + ' (ratio ' + r.earth_to_reference_mean_ratio + ').'); });
      if (sc) findings.push('Only ' + round(100 * sc.fraction_consistent, 1) + '% of Earth cells score consistently at 120 m and 360 m; analog statements depend on grid scale.');
      findings.push(round(100 * passN / grid.nKnown, 1) + '% of known Earth cells are passable under the base slope limit of ' + cfg.constraints.maxSlopeDeg + ' deg (a user-set or default assumption).');
      var out = {
        meta: meta('analog_intelligence'), label: M.LABEL, target: target, similarity: similarity, suitability: suitability, risk: risk, confidence: confidence,
        data_limitations: M.limitationsFor({ target: target, operating: 'earth', level: 'domain', placeholderRover: false }),
        findings: findings, evidence_gaps: gaps ? { counts: gaps.counts, items: gaps.items.filter(function (g) { var b = String(g.body).toLowerCase(); return b.indexOf(target) !== -1 || b.indexOf('earth') !== -1; }).map(function (g) { return { id: g.id, variable: g.variable, body: g.body, status: g.status, cannot_conclude: g.cannot_conclude }; }) } : null,
        environment: earthEnvironment()
      };
      if (opts.includeBaselinePortfolio && I && typeof I.portfolio === 'function') {
        try { var pf = I.portfolio(a, getRows('earth', 120), { target: target, n: cfg.objectives.numSites, minSepM: cfg.constraints.minSeparationM }); out.baseline_portfolio = { source: 'FieldZeroIntel.portfolio (reused unchanged; similarity + diversity only, ignores suitability, risk and strategy)', objective: pf.objective, comparison_to_top_scores_only: pf.comparison_to_top_scores_only, sites: pf.items.map(function (x) { return { pick: x.pick, csv_row_index: x.csv_row_index, lon_deg: x.lon_deg, lat_deg: x.lat_deg, score: x.score }; }) }; }
        catch (e) { out.baseline_portfolio = { status: 'error', message: e.message }; }
      }
      return finalize(out);
    }
    function earthEnvironment() {
      var c = D && D.climate && D.climate.earth;
      if (!c || !c.summary) return { status: 'not_loaded', note: 'Earth POWER climate summary is not loaded.' };
      var vars = {}, sm = c.summary;
      Object.keys(sm).forEach(function (k) { if (k.charAt(0) === '_') return; var x = sm[k]; vars[k] = { n: x.n, mean: x.mean, min: x.min, max: x.max, units: x.units }; });
      var cols = c.daily && c.daily.columns ? c.daily.columns : null;
      return { status: 'ok', basis: 'project_data', variables: vars, columns_loaded: cols, t2m_daily_mean_present: cols ? cols.indexOf('T2M') !== -1 : false, note: (sm._note || '') + ' One grid point, one year (2023). Not used by similarity, suitability, risk or routes: no comparable Mars or Moon data exist.' };
    }

    // ---------------------------------------------------------------- path evaluation, exports
    /**
     * Evaluate a path someone else produced (for example a simulation trace) with the same physics and limits.
     * rowIndices: csv row indices of consecutive 8-connected cells. opts: { body, scale, strategy, mission }
     */
    function evaluatePath(rowIndices, opts) {
      opts = opts || {};
      var v = resolveMission(opts.mission), cfg = v.config, strat = stratOf(opts.strategy), body = opts.body || cfg.operatingBody, scale = opts.scale || cfg.routeScaleM;
      if (!Array.isArray(rowIndices) || rowIndices.length < 2) throw MissionError('INVALID_PATH', 'Need at least two row indices.');
      var grid = getGrid(body, scale), fld = getField(grid, strat, cfg.constraints), cm = costModel(grid, fld, strat, cfg.rover, BODIES[body].gravity.value), cells = [], viol = [];
      rowIndices.forEach(function (ri, i) {
        if (!(Math.floor(ri) === ri) || ri < 0 || ri >= grid.nRows) { viol.push({ step: i, row_index: ri, issue: 'row_index_out_of_range' }); return; }
        var k = grid.cellOfRow[ri]; cells.push(k);
        var br = blockReason(grid, fld, k); if (br) viol.push({ step: i, row_index: ri, issue: br });
        if (cells.length > 1) { var a = cells[cells.length - 2], dx = Math.abs((k % grid.nx) - (a % grid.nx)), dy = Math.abs(((k / grid.nx) | 0) - ((a / grid.nx) | 0)); if (Math.max(dx, dy) !== 1) viol.push({ step: i, row_index: ri, issue: 'not_adjacent_to_previous_cell' }); }
      });
      if (viol.some(function (x) { return x.issue === 'row_index_out_of_range' || x.issue === 'not_adjacent_to_previous_cell'; })) return finalize({ status: 'invalid_path', violations: viol, strategy: strat.id });
      var pm;
      try { pm = pathMetrics(grid, fld, cm, cells, null); } catch (e) { viol.push({ step: null, row_index: null, issue: 'step_grade_above_limit' }); return finalize({ status: 'violations', violations: viol, strategy: strat.id }); }
      return finalize({ status: viol.length ? 'violations' : 'ok', violations: viol, strategy: strat.id, constraints_applied: M.effectiveConstraints(cfg.constraints, strat, scale), metrics: pm.metrics, metrics_basis: 'estimate (see plan.mission.assumptions)', segments: pm.seg, profile: pm.prof });
    }

    function routeOf(plan, strategyId) {
      var id = strategyId || plan.recommended_strategy || plan.source_strategy_for_top_level_sections, p = plan.strategies && plan.strategies[id];
      if (!p || !p.route || p.route.status !== 'ok') throw MissionError('NO_ROUTE', 'Strategy ' + id + ' has no feasible route to export.');
      return { id: id, plan: p, route: p.route };
    }
    /** Scenario for Person 3's simulation module. Shape documented in FieldZeroMissionModel.SIMULATION_SCHEMA. */
    function exportSimulationScenario(plan, strategyId) {
      var r = routeOf(plan, strategyId), rt = r.route, body = rt.body, grid = getGrid(body, rt.scale_m), cfg = plan.mission.config;
      return finalize({
        schema_version: M.SIMULATION_SCHEMA.version, kind: 'fieldzero_simulation_scenario', label: M.LABEL, body: body, scale_m: rt.scale_m,
        coordinate_frame: { name: 'local transverse Mercator metres (x_m_localTM, y_m_localTM)', note: M.SIMULATION_SCHEMA.note, lon_lat: BODIES[body].coordinate_system, wgs84: BODIES[body].wgs84 },
        grid: { nx: grid.nx, ny: grid.ny, x0_m: grid.x0, y0_m: grid.y0, spacing_m: grid.scale, n_rows: grid.nRows, source_table: body + '_' + grid.scale + 'm_terrain_csv', row_index_meaning: '0-based row of the terrain CSV' },
        vehicle: { parameters: cfg.rover, basis: plan.mission.vehicle_basis, is_placeholder: plan.mission.uses_placeholder_rover, gravity: Object.assign({ body: body }, BODIES[body].gravity), note: 'No real vehicle is modelled. Replace placeholder parameters with the vehicle under study.' },
        constraints: { user: { max_slope_deg: cfg.constraints.maxSlopeDeg, max_roughness_m: cfg.constraints.maxRoughnessM, keep_out: cfg.constraints.keepOut }, applied: rt.constraints_applied },
        strategy: { id: r.id, definition: r.plan.strategy_definition, cost_model: rt.cost_model },
        waypoints: rt.waypoints.map(function (w) { return { id: w.id, kind: w.kind, row_index: w.row_index, x_m: w.x_m, y_m: w.y_m, lon_deg: w.lon_deg, lat_deg: w.lat_deg, elevation_m: w.elevation_m }; }),
        path: rt.path.row_indices, profile: rt.profile, segments: rt.segments,
        expected: { metrics: rt.metrics, metrics_basis: rt.metrics_basis, visit_order_row_indices: rt.visit_order, resources: r.plan.resources, note: 'Expected values are ESTIMATES. A simulation should compare its own results against them, not treat them as ground truth.' },
        assumptions: plan.assumptions_and_estimates, data_limitations: rt.data_limitations
      });
    }
    /**
     * Evenly spaced samples along a planned route, by arc length. x, y, elevation (and lon/lat) are LINEAR INTERPOLATIONS
     * between real cell centres and are flagged `interpolated`; they are not new terrain data.
     */
    function sampleRoute(route, stepM) {
      if (!route || route.status !== 'ok') throw MissionError('NO_ROUTE', 'sampleRoute needs a route with status ok.');
      if (!(stepM > 0)) throw MissionError('INVALID_STEP', 'stepM must be > 0.');
      var P = route.path, cum = route.profile.distance_m, out = [], total = cum[cum.length - 1], d = 0, j = 0;
      for (d = 0; d <= total + 1e-9; d += stepM) {
        while (j < cum.length - 2 && cum[j + 1] < d) j++;
        var span = cum[j + 1] - cum[j], t = span > 0 ? Math.min(1, Math.max(0, (d - cum[j]) / span)) : 0, at = t === 0 || t === 1;
        function lerp(arr) { return arr[j] + (arr[j + 1] - arr[j]) * t; }
        out.push({ distance_m: round(d, 2), x_m: round(lerp(P.x_m), 3), y_m: round(lerp(P.y_m), 3), elevation_m: round(lerp(P.elevation_m), 3), lon_deg: round(lerp(P.lon_deg), 7), lat_deg: round(lerp(P.lat_deg), 7), at_cell_centre: at, interpolated: !at });
      }
      if (out.length && out[out.length - 1].distance_m < total - 1e-6) { var n = P.x_m.length - 1; out.push({ distance_m: round(total, 2), x_m: P.x_m[n], y_m: P.y_m[n], elevation_m: P.elevation_m[n], lon_deg: P.lon_deg[n], lat_deg: P.lat_deg[n], at_cell_centre: true, interpolated: false }); }
      return out;
    }
    /** GeoJSON for Person 2's map. Mars and Moon lon/lat are NOT WGS84 (flagged in metadata and properties). */
    function toGeoJSON(plan, opts) {
      opts = opts || {}; var features = [], body = plan.context.operating_body, wgs = BODIES[body].wgs84, ids = opts.strategies || Object.keys(plan.strategies);
      function pt(l, props) { return { type: 'Feature', geometry: { type: 'Point', coordinates: [l.lon_deg, l.lat_deg] }, properties: Object.assign({ row_index: l.row_index, x_m_localTM: l.x_m, y_m_localTM: l.y_m, elevation_m: l.elevation_m, wgs84: wgs }, props) }; }
      if (plan.context.staging) features.push(pt(plan.context.staging, { kind: 'staging', source: plan.context.staging.source, basis: plan.context.staging.basis }));
      ids.forEach(function (id) {
        var p = plan.strategies[id]; if (!p) return;
        (p.sites || []).forEach(function (s) { features.push(pt(s.location, { kind: 'site', strategy: id, rank: s.rank, composite: s.composite.score, similarity: s.similarity.score != null ? s.similarity.score : null, suitability: s.suitability.index, risk: s.risk.index, confidence: s.confidence.level })); });
        if (p.route && p.route.status === 'ok') {
          var rt = p.route;
          features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: rt.path.lon_deg.map(function (lo, i) { return [lo, rt.path.lat_deg[i]]; }) }, properties: { kind: 'route', strategy: id, distance_m: rt.metrics.distance_m, est_drive_time_h: rt.metrics.est_drive_time_h, est_energy_wh: rt.metrics.est_energy_wh, route_risk_index: rt.metrics.route_risk_index, basis: 'estimate', wgs84: wgs } });
          rt.waypoints.forEach(function (w) { features.push(pt(w, { kind: 'waypoint', waypoint_kind: w.kind, strategy: id, id: w.id })); });
        }
      });
      return finalize({ type: 'FeatureCollection', metadata: { title: plan.mission.config.name, label: M.LABEL, body: body, coordinate_note: wgs ? 'WGS84 lon/lat.' : BODIES[body].coordinate_system + '. Do not draw on an Earth basemap; use x_m_localTM / y_m_localTM.', engine_version: VERSION }, features: features });
    }
    /** Short human-readable summary for a brief or UI banner. */
    function summarize(plan) {
      var rec = plan.recommended_strategy, lines = [], t = plan.context;
      lines.push('Mission: ' + plan.mission.config.name + ' (' + t.target_body + ' analog, operating on ' + t.operating_body + ', ' + t.route_scale_m + ' m route grid).');
      plan.comparison.table.forEach(function (r) { lines.push(r.strategy + ': ' + (r.scores ? r.n_sites_visited + ' site(s), ' + r.distance_m + ' m, ~' + r.total_time_h + ' h total, ~' + r.energy_wh + ' Wh (estimates), mission risk index ' + r.mission_risk_index + ' (' + r.risk_class + '), mean site similarity ' + r.mean_site_similarity + ', confidence ' + r.confidence + (r.feasible === false ? ', EXCEEDS BUDGET' : '') : 'no feasible route (' + r.route_status + ')')); });
      lines.push('Recommendation: ' + (rec || 'none') + '. ' + plan.comparison.recommendation.rationale);
      plan.comparison.tradeoffs.forEach(function (x) { lines.push(x); });
      lines.push('Top limitations: ' + plan.data_limitations.slice(0, 4).map(function (l) { return l.id; }).join(', ') + ' (' + plan.data_limitations.length + ' in total).');
      return { headline: rec ? rec + ' recommended' : 'No recommendation', lines: lines, disclaimer: plan.disclaimer };
    }

    return {
      version: VERSION, model: M,
      validate: function (cfg) { return M.validateMissionConfig(cfg === undefined ? (options.mission || {}) : cfg); },
      ensureTerrain: ensureTerrain, getAnalysis: function () { return checkedAnalysis(); },
      assessDomain: assessDomain, assessSite: assessSite, rankSites: rankSites, planRoute: planRoute, optimize: optimize, run: run,
      evaluatePath: evaluatePath, exportSimulationScenario: exportSimulationScenario, sampleRoute: sampleRoute, toGeoJSON: toGeoJSON, summarize: summarize,
      info: function () {
        var out = { version: VERSION, model_version: M.version, similarity_engine_version: S.version, has_intel: !!I, has_data: !!D, analysis_ready: !!state.analysis, grids_built: Object.keys(state.grids) };
        return out;
      }
    };
  }

  /** Browser convenience: window.FZ from app.js has { data, analysis, rows }. Reuses its analysis; scores nothing twice. */
  function fromFZ(FZ, extra) {
    if (!FZ || !FZ.analysis) throw MissionError('NO_ANALYSIS', 'FZ.analysis is not ready yet. Call fromFZ after app.js has finished booting.');
    return create(Object.assign({ data: FZ.data, analysis: FZ.analysis, rows: FZ.rows }, extra || {}));
  }

  return { version: VERSION, create: create, fromFZ: fromFZ, MissionError: MissionError };
});
