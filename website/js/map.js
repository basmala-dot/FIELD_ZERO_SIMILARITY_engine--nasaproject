/*! FIELD//ZERO map (Leaflet). Earth: WGS84 (EPSG:3857 tiles). Mars/Moon: L.CRS.Simple in metres from the site centre,
 *  built from the body-native lon/lat in the project GeoJSON (NOT WGS84). No basemap exists for those two. */
(function (root) {
  'use strict';
  var RADIUS_M = { mars: 3396190, moon: 1737400 };   // IAU mean radii, used only for equirectangular display
  var BODIES = { earth: 'Earth · Western Desert', mars: 'Mars · Jezero Crater', moon: 'Moon · Taurus-Littrow' };
  var METRICS = [['slope_deg', 'Slope (°)'], ['roughness_std', 'Roughness (m)'], ['tri', 'TRI (m)'], ['elev_variability_std', 'Elevation variability (m)'], ['elevation', 'Elevation (m, own datum)']];
  var M = { FZ: null, map: null, body: 'earth', layer: 'score_mars', group: null, cand: null, port: null, sel: null, hooks: {}, cache: {}, tileErrors: 0 };
  var $ = function (id) { return document.getElementById(id); };
  var C0 = [94, 156, 154], C1 = [201, 162, 74], C2 = [182, 95, 67];
  function ramp(t) { t = Math.max(0, Math.min(1, t)); var a = t < .5 ? C0 : C1, b = t < .5 ? C1 : C2, u = t < .5 ? t * 2 : (t - .5) * 2;
    return 'rgb(' + a.map(function (v, i) { return Math.round(v + (b[i] - v) * u); }).join(',') + ')'; }
  function q(arr, p) { var s = arr.slice().sort(function (a, b) { return a - b; }); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]; }
  function fmt(v, d) { return v == null ? 'n/a' : (+v).toFixed(d == null ? 2 : d); }

  M.layersFor = function (b) { return (b === 'earth' ? [['score_mars', 'Similarity to Mars (Jezero), 0-100'], ['score_moon', 'Similarity to Moon (Taurus-Littrow), 0-100']] : []).concat(METRICS); };

  // ---- point sets (real data only) ----
  function earthPoints() {
    if (M.cache.earth) return M.cache.earth;
    var rows = M.FZ.rows, A = M.FZ.analysis, xs = rows.map(function (r) { return r.x_m_localTM; }), ys = rows.map(function (r) { return r.y_m_localTM; });
    var x0 = Math.min.apply(null, xs), y0 = Math.min.apply(null, ys), pts = [];
    rows.forEach(function (r, i) {
      if (Math.round((r.x_m_localTM - x0) / 120) % 3 || Math.round((r.y_m_localTM - y0) / 120) % 3) return;   // every 3rd cell in x and y (360 m display spacing)
      var m = A.results.mars[120].cells[i], o = A.results.moon[120].cells[i];
      pts.push({ body: 'earth', i: i, ll: [r.lat_deg, r.lon_deg], lon: r.lon_deg, lat: r.lat_deg, props: r,
        scores: { mars: m.status === 'scored' ? { score: m.score, rank: m.rank, f: m.features } : null, moon: o.status === 'scored' ? { score: o.score, rank: o.rank, f: o.features } : null },
        v: { score_mars: m.status === 'scored' ? m.score : null, score_moon: o.status === 'scored' ? o.score : null } });
    });
    return (M.cache.earth = pts);
  }
  function otherPoints(b) {
    if (M.cache[b]) return M.cache[b];
    var g = M.FZ.data.terrain[b][120].geojson; if (!g) return (M.cache[b] = []);
    var f = g.features, lons = f.map(function (x) { return x.geometry.coordinates[0]; }), lats = f.map(function (x) { return x.geometry.coordinates[1]; });
    var lon0 = (Math.min.apply(null, lons) + Math.max.apply(null, lons)) / 2, lat0 = (Math.min.apply(null, lats) + Math.max.apply(null, lats)) / 2, R = RADIUS_M[b], k = Math.PI / 180;
    return (M.cache[b] = f.map(function (x, i) { var c = x.geometry.coordinates;
      return { body: b, i: i, ll: [R * (c[1] - lat0) * k, R * Math.cos(lat0 * k) * (c[0] - lon0) * k], lon: c[0], lat: c[1], props: x.properties, scores: null, v: {} }; }));
  }
  function val(p, key) { return key in p.v ? p.v[key] : p.props[key]; }

  // ---- drawing ----
  M.init = function (FZ, hooks) {
    M.FZ = FZ; M.hooks = hooks || {};
    if (!root.L) { $('map').innerHTML = '<p style="padding:20px">The map library did not load (offline?). Terrain tables and charts still work.</p>'; return false; }
    return true;
  };
  M.setBody = function (b, layer) {
    if (!root.L) return;
    M.body = b; M.layer = layer || (b === 'earth' ? 'score_mars' : 'slope_deg');
    if (M.map) { M.map.remove(); M.map = null; }
    var simple = b !== 'earth';
    M.map = L.map('map', simple ? { crs: L.CRS.Simple, minZoom: -9, zoomSnap: .25, attributionControl: true } : { preferCanvas: true });
    M.map.attributionControl.setPrefix(false);
    M.tileErrors = 0; $('mapnote').hidden = true;
    if (!simple) {
      var t = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 17, attribution: '© OpenStreetMap contributors · terrain: NASADEM (NASA LP DAAC)' }).addTo(M.map);
      t.on('tileerror', function () { if (++M.tileErrors === 3) { $('mapnote').hidden = false; $('mapnote').textContent = 'Basemap tiles unavailable. Terrain cells are still real data.'; } });
    } else M.map.attributionControl.addAttribution(b === 'mars' ? 'CTX DEM 20 m, USGS Astrogeology · axes: metres from site centre (not WGS84)' : 'LRO LOLA 118 m, USGS Astrogeology · axes: metres from site centre (not WGS84)');
    var pts = simple ? otherPoints(b) : earthPoints();
    if (!pts.length) { $('mapnote').hidden = false; $('mapnote').textContent = 'No terrain data loaded for this body.'; return; }
    var bounds = L.latLngBounds(pts.map(function (p) { return p.ll; })); M.map.fitBounds(bounds.pad(.05));
    M.group = L.layerGroup().addTo(M.map); M.cand = L.layerGroup(); M.port = L.layerGroup(); M.sel = null;
    M.draw(); M.overlays();
  };
  M.draw = function () {
    if (!M.map) return; M.group.clearLayers();
    var pts = M.body === 'earth' ? earthPoints() : otherPoints(M.body), key = M.layer, vals = [];
    pts.forEach(function (p) { var v = val(p, key); if (v != null) vals.push(v); });
    var isScore = key.indexOf('score') === 0, lo = isScore ? 0 : q(vals, .02), hi = isScore ? 100 : q(vals, .98), missing = pts.length - vals.length;
    var cv = L.canvas({ padding: .3 });
    pts.forEach(function (p) { var v = val(p, key); if (v == null) return;
      L.circleMarker(p.ll, { renderer: cv, radius: M.body === 'earth' ? 3.2 : 3, stroke: false, fillOpacity: .85, fillColor: ramp((v - lo) / (hi - lo || 1)) })
        .on('click', function () { M.select(p); }).bindTooltip(fmt(p.lat, 4) + '°, ' + fmt(p.lon, 4) + '° · ' + fmt(v), { sticky: true }).addTo(M.group); });
    var lab = M.layersFor(M.body).filter(function (x) { return x[0] === key; })[0][1];
    $('maplegend').innerHTML = '<b>' + lab + '</b><div class="ramp"></div><div class="r"><span>' + fmt(lo, 1) + '</span><span>' + fmt(hi, 1) + '</span></div><div>' + (isScore ? 'Fixed 0-100 scale.' : 'Range = 2nd-98th percentile of shown cells.') + ' ' + vals.length + ' cells shown' + (missing ? ', ' + missing + ' without a value (border cells) left blank.' : '.') + '</div>';
    $('mapsrc').textContent = M.body === 'earth'
      ? 'Display shows every 3rd cell of the 120 m Earth grid (' + pts.length + ' of ' + M.FZ.rows.length + ' cells). Values and scores are the real per-cell values; positions are WGS84 lon/lat.'
      : 'Display uses the project\'s decimated GeoJSON (' + pts.length + ' cells). Positions are body-native lon/lat converted to metres with an equirectangular projection (R = ' + (RADIUS_M[M.body] / 1000) + ' km); elevations use this body\'s own datum and must not be compared with other bodies.';
  };
  M.setLayer = function (k) { M.layer = k; M.draw(); };
  function badge(txt, cls) { return L.divIcon({ className: '', html: '<div style="background:' + cls + ';color:#fff;border:2px solid #fff;border-radius:50%;width:22px;height:22px;font:600 11px/18px sans-serif;text-align:center;box-shadow:0 1px 4px rgba(0,0,0,.5)">' + txt + '</div>', iconSize: [22, 22] }); }
  M.overlays = function () {
    if (!M.map || M.body !== 'earth') return;
    M.cand.clearLayers();
    ['mars', 'moon'].forEach(function (t) { M.FZ.analysis.candidates[t].primary.forEach(function (c) {
      L.marker([c.lat_deg, c.lon_deg], { icon: badge(c.candidate_rank, t === 'mars' ? '#B65F43' : '#4A6FA5') }).bindTooltip((t === 'mars' ? 'Mars' : 'Moon') + ' candidate ' + c.candidate_rank + ' · score ' + fmt(c.score, 1))
        .on('click', function () { M.focus(c.lon_deg, c.lat_deg); }).addTo(M.cand); }); });
    if ($('candtoggle').checked) M.cand.addTo(M.map); if ($('porttoggle').checked) M.port.addTo(M.map);
  };
  M.showPortfolio = function (items) {
    if (!M.port) return; M.port.clearLayers();
    items.forEach(function (it) { L.marker([it.lat_deg, it.lon_deg], { icon: L.divIcon({ className: '', iconSize: [24, 24], html: '<div style="background:#C9A24A;color:#14213D;border:2px solid #14213D;transform:rotate(45deg);width:20px;height:20px;margin:2px"><span style="display:block;transform:rotate(-45deg);font:700 11px/16px sans-serif;text-align:center">' + it.pick + '</span></div>' }) })
      .bindTooltip('Portfolio site ' + it.pick + ' · score ' + fmt(it.score, 1)).on('click', function () { M.focus(it.lon_deg, it.lat_deg); }).addTo(M.port); });
  };
  M.toggle = function (which, on) { if (!M.map || !M[which]) return; on ? M[which].addTo(M.map) : M.map.removeLayer(M[which]); };
  M.select = function (p) {
    if (M.sel && M.map) M.map.removeLayer(M.sel);
    if (M.map) M.sel = L.circleMarker(p.ll, { radius: 9, color: '#FFFFFF', weight: 3, fillOpacity: 0, interactive: false }).addTo(M.map);
    if (M.hooks.onSelect) M.hooks.onSelect(p);
  };
  /** Select the real Earth cell at an exact lon/lat (candidate / portfolio coordinates come from the same CSV). */
  M.focus = function (lon, lat) {
    var rows = M.FZ.rows; if (!M.cache.idx) { M.cache.idx = {}; rows.forEach(function (r, i) { M.cache.idx[r.lon_deg + ',' + r.lat_deg] = i; }); }
    var i = M.cache.idx[lon + ',' + lat]; if (i == null) return;
    var go = function () { var r = rows[i], A = M.FZ.analysis, m = A.results.mars[120].cells[i], o = A.results.moon[120].cells[i];
      var p = { body: 'earth', i: i, ll: [r.lat_deg, r.lon_deg], lon: r.lon_deg, lat: r.lat_deg, props: r,
        scores: { mars: m.status === 'scored' ? { score: m.score, rank: m.rank, f: m.features } : null, moon: o.status === 'scored' ? { score: o.score, rank: o.rank, f: o.features } : null }, v: {} };
      M.map.setView(p.ll, Math.max(M.map.getZoom(), 12)); M.select(p); };
    if (M.body !== 'earth') { M.hooks.needEarth && M.hooks.needEarth(); setTimeout(go, 50); } else go();
  };
  M.RADIUS_M = RADIUS_M; M.BODIES = BODIES;
  root.FZMap = M;
})(window);
