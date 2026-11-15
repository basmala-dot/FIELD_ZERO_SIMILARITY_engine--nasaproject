/*!
 * FIELD//ZERO data loader
 *
 * Loads website/site_manifest.json, then loads the datasets it registers
 * (GeoJSON, JSON and CSV) and exposes them as one clean object.
 *
 * Rules this module follows:
 *  - Missing values stay null. Nothing is ever filled, interpolated, defaulted or guessed.
 *  - A dataset that cannot be loaded is reported (code, message, URL, hint) and left as null.
 *    It is never replaced by placeholder data.
 *  - Structural problems (wrong columns, bad numbers, ragged rows, wrong file type) are errors.
 *    Count/range/checksum differences against the manifest are warnings; the data is still returned.
 *
 * Works in browsers (<script src="js/data-loader.js">) and in Node 18+ (require).
 * Browser:  const info = await FieldZeroData.init();
 *           await FieldZeroData.loadAll();
 *           const earth120 = FieldZeroData.data.terrain.earth['120'].geojson;
 * Paths in the manifest are resolved against the manifest's own URL, not the page URL, so
 * pages in any folder can use the loader. The web server root must be the project root.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.FieldZeroData = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function (root) {
  'use strict';

  // Captured while the script is executing; used to find ../site_manifest.json in browsers.
  var SCRIPT_URL = (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) || null;

  var DEFAULT_MISSING_TOKENS = ['', 'nan', 'na', 'n/a', 'null', 'none'];
  var BOUNDS_TOLERANCE_DEG = 1e-4;

  // ---------------------------------------------------------------- errors
  function DataLoadError(code, message, details) {
    var e = new Error(message);
    e.name = 'DataLoadError';
    e.code = code;
    details = details || {};
    e.id = details.id || null;
    e.url = details.url || null;
    e.status = details.status == null ? null : details.status;
    e.hint = details.hint || null;
    e.cause = details.cause || null;
    return e;
  }
  DataLoadError.prototype = Object.create(Error.prototype);

  function errorInfo(err) {
    if (err && err.name === 'DataLoadError') {
      return { code: err.code, message: err.message, id: err.id, url: err.url, status: err.status, hint: err.hint };
    }
    return { code: 'UNEXPECTED_ERROR', message: String(err && err.message || err), id: null, url: null, status: null, hint: null };
  }

  // ---------------------------------------------------------------- CSV
  /**
   * RFC 4180 style parser. Handles BOM, LF/CRLF/CR, quoted fields, escaped quotes.
   * Returns array of rows (arrays of strings). Blank lines are skipped.
   */
  function splitCsv(text) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    var rows = [];
    var i, n, line;
    if (text.indexOf('"') === -1) {              // fast path, no quoting anywhere
      var lines = text.split(/\r\n|\n|\r/);
      for (i = 0, n = lines.length; i < n; i++) {
        line = lines[i];
        if (line === '') continue;
        rows.push(line.split(','));
      }
      return rows;
    }
    var field = '', row = [], inQuotes = false, started = false;
    for (i = 0, n = text.length; i < n; i++) {
      var c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
        } else field += c;
      } else if (c === '"' && field === '') {
        inQuotes = true; started = true;
      } else if (c === ',') {
        row.push(field); field = ''; started = true;
      } else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        if (started || field !== '' || row.length) { row.push(field); rows.push(row); }
        field = ''; row = []; started = false;
      } else { field += c; started = true; }
    }
    if (inQuotes) throw DataLoadError('PARSE_ERROR', 'CSV ends inside a quoted field (unbalanced quote).');
    if (started || field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  /**
   * Parse CSV text into a typed table.
   * options: { missingTokens, numericColumns, stringColumns, expectedColumns }
   * Missing tokens become null. A numeric column containing a non-missing, non-numeric
   * value is an error (it is never coerced to 0 or NaN).
   */
  function parseCsv(text, options) {
    options = options || {};
    var tokens = (options.missingTokens || DEFAULT_MISSING_TOKENS).map(function (t) { return String(t).toLowerCase(); });
    var tokenSet = {};
    tokens.forEach(function (t) { tokenSet[t] = true; });
    var raw = splitCsv(text);
    if (!raw.length) throw DataLoadError('PARSE_ERROR', 'CSV is empty.');
    var columns = raw[0].map(function (h) { return h.trim(); });
    if (columns.some(function (h) { return h === ''; })) throw DataLoadError('PARSE_ERROR', 'CSV header contains an empty column name.');
    var dup = columns.filter(function (h, i) { return columns.indexOf(h) !== i; });
    if (dup.length) throw DataLoadError('PARSE_ERROR', 'CSV header has duplicate column(s): ' + dup.join(', '));
    var ncol = columns.length, nrow = raw.length - 1;

    // ragged rows are structural damage: refuse instead of guessing which field is missing
    var ragged = [];
    for (var r = 1; r <= nrow; r++) if (raw[r].length !== ncol) { ragged.push(r + 1); if (ragged.length >= 5) break; }
    if (ragged.length) {
      throw DataLoadError('PARSE_ERROR', 'CSV has rows with the wrong number of fields (expected ' + ncol + '), first at file line(s) ' + ragged.join(', ') + '.');
    }

    var numericSet = {}, stringSet = {};
    (options.numericColumns || []).forEach(function (c) { numericSet[c] = true; });
    (options.stringColumns || []).forEach(function (c) { stringSet[c] = true; });
    var nullCounts = {}, types = {}, converted = new Array(ncol);

    for (var c = 0; c < ncol; c++) {
      var name = columns[c], vals = new Array(nrow), nulls = 0, allNumeric = true, anyValue = false;
      for (var k = 0; k < nrow; k++) {
        var s = raw[k + 1][c].trim();
        if (tokenSet[s.toLowerCase()] === true) { vals[k] = null; nulls++; continue; }
        anyValue = true;
        vals[k] = s;
      }
      var forceNumeric = numericSet[name] === true, forceString = stringSet[name] === true;
      if (!forceString) {
        // try numeric
        var nums = new Array(nrow);
        for (var m = 0; m < nrow; m++) {
          var v = vals[m];
          if (v === null) { nums[m] = null; continue; }
          var num = Number(v);
          if (v === '' || !isFinite(num)) {
            allNumeric = false;
            if (forceNumeric) {
              throw DataLoadError('PARSE_ERROR', 'Column "' + name + '" must be numeric but line ' + (m + 2) + ' contains "' + v + '".');
            }
            break;
          }
          nums[m] = num;
        }
        if (allNumeric && (anyValue || forceNumeric)) { converted[c] = nums; types[name] = 'number'; }
        else { converted[c] = vals; types[name] = 'string'; }
      } else { converted[c] = vals; types[name] = 'string'; }
      nullCounts[name] = nulls;
    }

    var rows = new Array(nrow);
    for (var i = 0; i < nrow; i++) {
      var o = {};
      for (var j = 0; j < ncol; j++) o[columns[j]] = converted[j][i];
      rows[i] = o;
    }
    return { columns: columns, rows: rows, rowCount: nrow, nullCounts: nullCounts, columnTypes: types };
  }

  // ---------------------------------------------------------------- helpers
  function column(table, name) {
    if (!table || table.columns.indexOf(name) === -1) return null;
    return table.rows.map(function (r) { return r[name]; });
  }
  function parseYyyymmdd(n) {
    if (n == null) return null;
    var s = String(n);
    if (!/^\d{8}$/.test(s)) return null;
    var y = +s.slice(0, 4), m = +s.slice(4, 6), d = +s.slice(6, 8);
    var dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
    return dt;
  }
  function hex(buf) {
    var b = new Uint8Array(buf), out = '';
    for (var i = 0; i < b.length; i++) out += (b[i] < 16 ? '0' : '') + b[i].toString(16);
    return out;
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function looksLikeHtml(text) { return /^\s*<(!doctype|html|head|body)/i.test(text.slice(0, 200)); }

  // ---------------------------------------------------------------- loader state
  var state = null;

  function freshState() {
    return {
      ready: false, manifestUrl: null, manifest: null, options: {},
      entries: {}, order: [], status: {}, results: {}, inflight: {}, listeners: {},
      data: {
        manifest: null, sources: null, unavailable: [],
        byId: {}, meta: {},
        terrain: {}, climate: {}, comparison: {}
      }
    };
  }
  var api = {};
  api.data = freshState().data;     // replaced in place by init(), so references stay valid

  function emit(evt, payload) {
    if (!state) return;
    (state.listeners[evt] || []).slice().forEach(function (fn) {
      try { fn(payload); } catch (e) { if (typeof console !== 'undefined') console.error('[FieldZeroData] listener error', e); }
    });
  }

  function resetDataObject(target) {
    Object.keys(target).forEach(function (k) { delete target[k]; });
    var fresh = freshState().data;
    Object.keys(fresh).forEach(function (k) { target[k] = fresh[k]; });
  }

  function fetchFn() {
    var f = state.options.fetch || (typeof fetch === 'function' ? fetch : null);
    if (!f) throw DataLoadError('NO_FETCH', 'No fetch() available in this environment.', { hint: 'Use a modern browser or Node 18+, or pass options.fetch.' });
    return f;
  }

  function networkHint(url) {
    if (typeof location !== 'undefined' && location.protocol === 'file:') {
      return 'The page is opened from file://. Browsers block fetch() there. Start a local server in the PROJECT ROOT (e.g. "python -m http.server 8000") and open http://localhost:8000/website/.';
    }
    return 'Network request failed (server not running, wrong host/port, CORS, or offline). URL: ' + url;
  }

  function fetchBytesOrText(url, id, wantBuffer) {
    var retries = state.options.retries, timeoutMs = state.options.timeoutMs, attempt = 0;
    function once() {
      var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeoutMs) : null;
      return Promise.resolve().then(function () {
        return fetchFn()(url, ctrl ? { signal: ctrl.signal } : undefined);
      }).then(function (res) {
        if (!res.ok) {
          var code = res.status === 404 ? 'FILE_NOT_FOUND' : 'HTTP_ERROR';
          var msg = res.status === 404
            ? 'File not found (HTTP 404): ' + url
            : 'Server returned HTTP ' + res.status + ' ' + (res.statusText || '') + ' for ' + url;
          throw DataLoadError(code, msg, {
            id: id, url: url, status: res.status,
            hint: res.status === 404
              ? 'The manifest path does not point to an existing file. Check the path (spaces must be %20), that the file exists in Data/processed/, and that the server root is the project root.'
              : null
          });
        }
        return wantBuffer ? res.arrayBuffer() : res.text();
      }).then(function (body) { if (timer) clearTimeout(timer); return body; },
        function (err) {
          if (timer) clearTimeout(timer);
          if (err && err.name === 'DataLoadError') throw err;
          if (err && err.name === 'AbortError') {
            throw DataLoadError('TIMEOUT', 'Request timed out after ' + timeoutMs + ' ms: ' + url, { id: id, url: url, cause: err, hint: 'Slow or stalled server. Increase options.timeoutMs for large files.' });
          }
          throw DataLoadError('NETWORK_ERROR', 'Could not fetch ' + url + (err && err.message ? ' (' + err.message + ')' : ''), { id: id, url: url, cause: err, hint: networkHint(url) });
        });
    }
    function run() {
      return once().catch(function (err) {
        var retryable = err.code === 'NETWORK_ERROR' || err.code === 'TIMEOUT' || (err.code === 'HTTP_ERROR' && err.status >= 500);
        if (retryable && attempt < retries) { attempt++; return sleep(300 * attempt).then(run); }
        throw err;
      });
    }
    return run();
  }

  // ---------------------------------------------------------------- validators
  function inc(obj, key) { obj[key] = (obj[key] || 0) + 1; }

  function validateGeoJson(entry, gj, warnings) {
    var id = entry.id;
    if (!gj || gj.type !== 'FeatureCollection' || !Array.isArray(gj.features)) {
      throw DataLoadError('VALIDATION_ERROR', id + ': not a GeoJSON FeatureCollection with a features array.', { id: id });
    }
    var exp = entry.expected || {}, geomTypes = {}, nullCounts = {}, badCoords = 0, noGeom = 0;
    var lon = [Infinity, -Infinity], lat = [Infinity, -Infinity];
    var propKeys = {};
    gj.features.forEach(function (f) {
      if (!f || !f.geometry) { noGeom++; return; }
      inc(geomTypes, f.geometry.type);
      if (f.geometry.type === 'Point') {
        var c = f.geometry.coordinates;
        if (!Array.isArray(c) || c.length < 2 || !isFinite(c[0]) || !isFinite(c[1]) || c[0] === null || c[1] === null) { badCoords++; return; }
        if (c[0] < lon[0]) lon[0] = c[0]; if (c[0] > lon[1]) lon[1] = c[0];
        if (c[1] < lat[0]) lat[0] = c[1]; if (c[1] > lat[1]) lat[1] = c[1];
      }
      var p = f.properties || {};
      Object.keys(p).forEach(function (k) {
        propKeys[k] = true;
        if (p[k] === null) inc(nullCounts, k);
      });
    });
    if (badCoords) throw DataLoadError('VALIDATION_ERROR', id + ': ' + badCoords + ' Point feature(s) have missing/non-finite coordinates.', { id: id, hint: 'Features with unusable coordinates are not dropped or repaired automatically.' });
    if (noGeom) warnings.push(noGeom + ' feature(s) have null geometry.');
    if (exp.geometry_type) {
      Object.keys(geomTypes).forEach(function (t) {
        if (t !== exp.geometry_type) warnings.push('Unexpected geometry type "' + t + '" (' + geomTypes[t] + ' features); manifest expects ' + exp.geometry_type + '.');
      });
    }
    if (exp.feature_count != null && exp.feature_count !== gj.features.length) {
      warnings.push('Feature count ' + gj.features.length + ' differs from manifest (' + exp.feature_count + '). The file may have been regenerated.');
    }
    if (exp.property_keys) {
      var missing = exp.property_keys.filter(function (k) { return !propKeys[k]; });
      var extra = Object.keys(propKeys).filter(function (k) { return exp.property_keys.indexOf(k) === -1; });
      if (missing.length) throw DataLoadError('VALIDATION_ERROR', id + ': features lack expected propert' + (missing.length > 1 ? 'ies' : 'y') + ': ' + missing.join(', '), { id: id });
      if (extra.length) warnings.push('Extra property key(s) not in manifest: ' + extra.join(', '));
    }
    if (exp.bounds && gj.features.length) {
      var b = exp.bounds, t = BOUNDS_TOLERANCE_DEG;
      if (lon[0] < b.lon[0] - t || lon[1] > b.lon[1] + t || lat[0] < b.lat[0] - t || lat[1] > b.lat[1] + t) {
        warnings.push('Coordinates fall outside manifest bounds: lon ' + lon.join('..') + ', lat ' + lat.join('..') + '.');
      }
    }
    return { featureCount: gj.features.length, geometryTypes: geomTypes, nullCounts: nullCounts, bounds: { lon: lon, lat: lat } };
  }

  function validateSummary(entry, obj, warnings) {
    var id = entry.id, exp = entry.expected || {};
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw DataLoadError('VALIDATION_ERROR', id + ': summary JSON is not an object.', { id: id });
    var missing = (exp.required_keys || []).filter(function (k) { return !(k in obj); });
    if (missing.length) throw DataLoadError('VALIDATION_ERROR', id + ': summary JSON lacks required key(s): ' + missing.join(', '), { id: id });
    if (entry.scale_m != null && obj.scale_m != null && obj.scale_m !== entry.scale_m) warnings.push('scale_m in file (' + obj.scale_m + ') differs from manifest (' + entry.scale_m + ').');
    (entry.missing_variables || []).forEach(function (mv) {
      if (mv.name in obj) warnings.push('Manifest lists "' + mv.name + '" as unavailable but the file contains it; update the manifest.');
    });
    return { keys: Object.keys(obj) };
  }

  function validateTable(entry, table, warnings) {
    var id = entry.id, exp = entry.expected || {};
    if (exp.columns) {
      var missing = exp.columns.filter(function (c) { return table.columns.indexOf(c) === -1; });
      var extra = table.columns.filter(function (c) { return exp.columns.indexOf(c) === -1; });
      if (missing.length) throw DataLoadError('VALIDATION_ERROR', id + ': CSV lacks expected column(s): ' + missing.join(', ') + '. Found: ' + table.columns.join(', '), { id: id });
      if (extra.length) warnings.push('Extra column(s) not in manifest: ' + extra.join(', '));
      if (!missing.length && !extra.length && exp.columns.join() !== table.columns.join()) warnings.push('Column order differs from manifest.');
    }
    if (exp.row_count != null && exp.row_count !== table.rowCount) warnings.push('Row count ' + table.rowCount + ' differs from manifest (' + exp.row_count + '). The file may have been regenerated.');
    if (exp.date_column && table.columns.indexOf(exp.date_column) !== -1) {
      var bad = 0;
      for (var i = 0; i < table.rows.length; i++) if (parseYyyymmdd(table.rows[i][exp.date_column]) === null) bad++;
      if (bad) warnings.push(bad + ' value(s) in "' + exp.date_column + '" are not valid ' + (exp.date_format || 'dates') + ' (null or malformed).');
    }
    (entry.missing_variables || []).forEach(function (mv) {
      if (table.columns.indexOf(mv.name) !== -1) warnings.push('Manifest lists "' + mv.name + '" as unavailable but the CSV contains it; update the manifest.');
    });
    return { rowCount: table.rowCount, columns: table.columns, columnTypes: table.columnTypes, nullCounts: table.nullCounts };
  }

  // ---------------------------------------------------------------- loading one dataset
  function loadEntry(entry) {
    var id = entry.id, url = entry.url, warnings = [];
    var verify = state.options.verifyChecksum && entry.sha256;
    var wantBuffer = !!verify;
    return fetchBytesOrText(url, id, wantBuffer).then(function (body) {
      var textP;
      if (wantBuffer) {
        var subtle = root.crypto && root.crypto.subtle;
        var hashP = subtle ? subtle.digest('SHA-256', body).then(hex) : Promise.resolve(null);
        textP = hashP.then(function (h) {
          if (h === null) warnings.push('Checksum not verified: crypto.subtle is unavailable (needs https or localhost).');
          else if (h !== entry.sha256) warnings.push('SHA-256 differs from manifest; file changed since the manifest was generated.');
          return new TextDecoder('utf-8').decode(body);
        });
      } else textP = Promise.resolve(body);
      return textP;
    }).then(function (text) {
      if (looksLikeHtml(text)) {
        throw DataLoadError('PARSE_ERROR', id + ': server returned an HTML page instead of a ' + entry.format.toUpperCase() + ' file.', { id: id, url: url, hint: 'Usually a wrong path handled by a fallback page, or the server root is not the project root.' });
      }
      var payload, info, exp = entry.expected || {};
      if (entry.format === 'csv') {
        var table;
        try {
          table = parseCsv(text, { missingTokens: state.manifest.missing_tokens, numericColumns: exp.numeric_columns, stringColumns: exp.string_columns });
        } catch (e) {
          if (e.name === 'DataLoadError') { e.id = id; e.url = url; }
          throw e;
        }
        info = validateTable(entry, table, warnings);
        payload = table;
      } else {
        var parsed;
        try { parsed = JSON.parse(text); }
        catch (e) { throw DataLoadError('PARSE_ERROR', id + ': invalid JSON (' + e.message + ')', { id: id, url: url, cause: e }); }
        if (entry.format === 'geojson') info = validateGeoJson(entry, parsed, warnings);
        else info = validateSummary(entry, parsed, warnings);
        payload = parsed;
      }
      return { payload: payload, meta: info, warnings: warnings };
    });
  }

  function place(entry, payload) {
    var d = state.data, id = entry.id;
    d.byId[id] = payload;
    var scale = entry.scale_m != null ? String(entry.scale_m) : null;
    switch (entry.kind) {
      case 'terrain_geojson': d.terrain[entry.body][scale].geojson = payload; break;
      case 'terrain_summary': d.terrain[entry.body][scale].summary = payload; break;
      case 'terrain_csv': d.terrain[entry.body][scale].csv = payload; break;
      case 'climate_csv': d.climate[entry.body].daily = payload; break;
      case 'climate_summary': d.climate[entry.body].summary = payload; break;
      case 'comparison': d.comparison[scale] = payload; break;
      default: break;   // unknown kinds remain reachable through data.byId
    }
  }

  // ---------------------------------------------------------------- public API
  /**
   * Load and validate the manifest. Rejects with DataLoadError if the manifest itself is unusable.
   * options: { manifestUrl, manifest (object), baseUrl, fetch, timeoutMs=30000, retries=2, verifyChecksum=false }
   */
  api.init = function (options) {
    options = options || {};
    var keptListeners = state ? state.listeners : {};
    state = freshState();
    state.listeners = keptListeners;
    state.options = {
      fetch: options.fetch || null,
      timeoutMs: options.timeoutMs == null ? 30000 : options.timeoutMs,
      retries: options.retries == null ? 2 : options.retries,
      verifyChecksum: !!options.verifyChecksum
    };
    resetDataObject(api.data);
    state.data = api.data;

    var manifestUrl = options.manifestUrl || null;
    try {
      if (!manifestUrl) {
        if (options.baseUrl) manifestUrl = new URL('site_manifest.json', options.baseUrl).href;
        else if (SCRIPT_URL) manifestUrl = new URL('../site_manifest.json', SCRIPT_URL).href;
        else if (typeof location !== 'undefined') manifestUrl = new URL('site_manifest.json', location.href).href;
      }
      if (manifestUrl) manifestUrl = new URL(manifestUrl, typeof location !== 'undefined' ? location.href : undefined).href;
    } catch (e) {
      return Promise.reject(DataLoadError('MANIFEST_INVALID', 'Invalid manifest URL: ' + manifestUrl, { cause: e }));
    }
    if (!manifestUrl) {
      return Promise.reject(DataLoadError('MANIFEST_NOT_FOUND', 'Cannot determine the manifest URL.', { hint: 'Pass { manifestUrl: "http://host/website/site_manifest.json" } (required outside a browser).' }));
    }
    state.manifestUrl = manifestUrl;

    var p;
    if (options.manifest) p = Promise.resolve(options.manifest);
    else {
      p = fetchBytesOrText(manifestUrl, null, false).then(function (text) {
        try { return JSON.parse(text); }
        catch (e) { throw DataLoadError('MANIFEST_INVALID', 'Manifest is not valid JSON: ' + e.message, { url: manifestUrl, cause: e }); }
      }, function (err) {
        if (err.code === 'FILE_NOT_FOUND') throw DataLoadError('MANIFEST_NOT_FOUND', 'Manifest not found (HTTP 404): ' + manifestUrl, { url: manifestUrl, status: 404, hint: 'Expected website/site_manifest.json. Serve the project root and keep js/ next to the manifest.' });
        throw err;
      });
    }
    return p.then(function (manifest) {
      if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.datasets)) {
        throw DataLoadError('MANIFEST_INVALID', 'Manifest has no "datasets" array.', { url: manifestUrl });
      }
      var seen = {}, problems = [];
      manifest.datasets.forEach(function (d, i) {
        if (!d || !d.id) { problems.push('datasets[' + i + '] has no id'); return; }
        if (seen[d.id]) problems.push('duplicate id "' + d.id + '"');
        seen[d.id] = true;
        ['path', 'format', 'kind'].forEach(function (k) { if (!d[k]) problems.push(d.id + ': missing "' + k + '"'); });
        if (d.format && ['csv', 'json', 'geojson'].indexOf(d.format) === -1) problems.push(d.id + ': unsupported format "' + d.format + '"');
        if (d.path && /\s/.test(d.path)) problems.push(d.id + ': path contains an unencoded space (use %20)');
      });
      if (problems.length) throw DataLoadError('MANIFEST_INVALID', 'Manifest problems: ' + problems.join('; '), { url: manifestUrl });

      state.manifest = manifest;
      var d = state.data;
      d.manifest = manifest;
      d.sources = manifest.sources || {};
      d.unavailable = manifest.unavailable || [];
      manifest.datasets.forEach(function (e) {
        var entry = Object.assign({}, e);
        try { entry.url = new URL(e.path, manifestUrl).href; }
        catch (err) { throw DataLoadError('MANIFEST_INVALID', e.id + ': cannot resolve path "' + e.path + '" against ' + manifestUrl, { cause: err }); }
        state.entries[e.id] = entry;
        state.order.push(e.id);
        state.status[e.id] = 'idle';
        // pre-create slots as null so consumers can tell "registered but not loaded" from "unknown"
        var scale = e.scale_m != null ? String(e.scale_m) : null;
        if (/^terrain_/.test(e.kind)) {
          d.terrain[e.body] = d.terrain[e.body] || {};
          d.terrain[e.body][scale] = d.terrain[e.body][scale] || { geojson: null, summary: null, csv: null };
        } else if (/^climate_/.test(e.kind)) {
          d.climate[e.body] = d.climate[e.body] || { daily: null, summary: null, missingVariables: [] };
          (e.missing_variables || []).forEach(function (mv) {
            if (!d.climate[e.body].missingVariables.some(function (x) { return x.name === mv.name; })) d.climate[e.body].missingVariables.push(mv);
          });
        } else if (e.kind === 'comparison') d.comparison[scale] = null;
        d.byId[e.id] = null;
        d.meta[e.id] = null;
      });
      state.ready = true;
      var summary = { manifestUrl: manifestUrl, schemaVersion: manifest.schema_version || null, datasetCount: state.order.length, ids: state.order.slice() };
      emit('ready', summary);
      return summary;
    });
  };

  /**
   * Load one dataset. Always resolves (never rejects for a dataset problem):
   *   { id, ok, data, meta, warnings, error, url }
   * On failure data is null and error holds { code, message, url, status, hint }.
   * Repeated calls reuse the result; pass { force: true } to reload.
   */
  api.load = function (id, opts) {
    opts = opts || {};
    if (!state || !state.ready) {
      return Promise.resolve({ id: id, ok: false, data: null, meta: null, warnings: [], url: null, error: errorInfo(DataLoadError('NOT_INITIALISED', 'Call FieldZeroData.init() before load().', { id: id })) });
    }
    var entry = state.entries[id];
    if (!entry) {
      var known = state.order.join(', ');
      return Promise.resolve({ id: id, ok: false, data: null, meta: null, warnings: [], url: null, error: errorInfo(DataLoadError('UNKNOWN_ID', 'Unknown dataset id "' + id + '". Registered ids: ' + known, { id: id })) });
    }
    if (!opts.force) {
      if (state.inflight[id]) return state.inflight[id];
      if (state.results[id]) return Promise.resolve(state.results[id]);
    }
    state.status[id] = 'loading';
    var started = state.inflight[id] = loadEntry(entry).then(function (r) {
      var result = { id: id, ok: true, data: r.payload, meta: r.meta, warnings: r.warnings, error: null, url: entry.url };
      place(entry, r.payload);
      state.data.meta[id] = { info: r.meta, warnings: r.warnings, url: entry.url };
      state.status[id] = 'loaded';
      state.results[id] = result;
      emit('loaded', result);
      return result;
    }, function (err) {
      var info = errorInfo(err);
      if (!info.id) info.id = id;
      if (!info.url) info.url = entry.url;
      var result = { id: id, ok: false, data: null, meta: null, warnings: [], error: info, url: entry.url };
      // make sure a stale earlier payload is not left behind on a failed reload
      state.data.byId[id] = null;
      state.data.meta[id] = { info: null, warnings: [], url: entry.url, error: info };
      state.status[id] = 'error';
      state.results[id] = result;
      emit('error', result);
      return result;
    }).then(function (result) { delete state.inflight[id]; return result; });
    return started;
  };

  /**
   * Load many datasets. options:
   *   mode: 'auto' (default; entries with load:"auto") | 'all' | 'on_demand'
   *   ids: explicit list (overrides mode) · kind/body/scale_m: filters · concurrency=4
   *   onProgress({ id, done, total, ok })
   * Resolves with api.report().
   */
  api.loadAll = function (options) {
    options = options || {};
    if (!state || !state.ready) return Promise.reject(DataLoadError('NOT_INITIALISED', 'Call FieldZeroData.init() before loadAll().'));
    var ids = options.ids ? options.ids.slice() : api.list({ mode: options.mode || 'auto', kind: options.kind, body: options.body, scale_m: options.scale_m }).map(function (e) { return e.id; });
    var total = ids.length, done = 0, next = 0, limit = Math.max(1, options.concurrency || 4);
    function worker() {
      if (next >= ids.length) return Promise.resolve();
      var id = ids[next++];
      return api.load(id).then(function (r) {
        done++;
        emit('progress', { id: id, done: done, total: total, ok: r.ok });
        if (typeof options.onProgress === 'function') options.onProgress({ id: id, done: done, total: total, ok: r.ok });
        return worker();
      });
    }
    var workers = [];
    for (var i = 0; i < Math.min(limit, total); i++) workers.push(worker());
    return Promise.all(workers).then(function () { return api.report(); });
  };

  /** Synchronous access. Returns the loaded payload, or null if not loaded / failed / unknown. */
  api.get = function (id) { return state && state.data.byId[id] !== undefined ? state.data.byId[id] : null; };
  api.getResult = function (id) { return state && state.results[id] || null; };
  api.getEntry = function (id) { return state && state.entries[id] ? Object.assign({}, state.entries[id]) : null; };
  api.getSource = function (sourceId) { return state && state.data.sources ? state.data.sources[sourceId] || null : null; };

  /** List registered datasets. filter: { mode, kind, body, site, scale_m, format } */
  api.list = function (filter) {
    filter = filter || {};
    if (!state) return [];
    return state.order.map(function (id) { return state.entries[id]; }).filter(function (e) {
      if (filter.mode && filter.mode !== 'all') {
        var m = e.load || 'auto';
        if (m !== filter.mode) return false;
      }
      if (filter.kind && e.kind !== filter.kind) return false;
      if (filter.body && e.body !== filter.body) return false;
      if (filter.site && e.site !== filter.site) return false;
      if (filter.format && e.format !== filter.format) return false;
      if (filter.scale_m != null && e.scale_m !== filter.scale_m) return false;
      return true;
    }).map(function (e) { return Object.assign({}, e); });
  };

  api.status = function () {
    if (!state) return [];
    return state.order.map(function (id) {
      var r = state.results[id];
      return { id: id, status: state.status[id], ok: r ? r.ok : null, url: state.entries[id].url, warnings: r ? r.warnings.length : 0, error: r && r.error ? r.error : null };
    });
  };

  /** Summary of everything attempted so far. */
  api.report = function () {
    if (!state) return null;
    var loaded = [], failed = [], notLoaded = [], missingFiles = [], warnings = [];
    state.order.forEach(function (id) {
      var r = state.results[id];
      if (!r) { notLoaded.push(id); return; }
      if (r.ok) { loaded.push(id); r.warnings.forEach(function (w) { warnings.push({ id: id, message: w }); }); }
      else {
        failed.push({ id: id, code: r.error.code, message: r.error.message, url: r.error.url, hint: r.error.hint });
        if (r.error.code === 'FILE_NOT_FOUND') missingFiles.push({ id: id, url: r.error.url });
      }
    });
    return {
      total: state.order.length, loaded: loaded, failed: failed, notLoaded: notLoaded,
      missingFiles: missingFiles, warnings: warnings,
      ok: failed.length === 0 && loaded.length > 0
    };
  };

  api.on = function (evt, fn) {
    if (!state) state = freshState();
    (state.listeners[evt] = state.listeners[evt] || []).push(fn);
    return function off() { var a = state.listeners[evt] || []; var i = a.indexOf(fn); if (i !== -1) a.splice(i, 1); };
  };

  api.DataLoadError = DataLoadError;
  api.util = { parseCsv: parseCsv, column: column, parseYyyymmdd: parseYyyymmdd };
  api.version = '1.0.0';
  return api;
});
