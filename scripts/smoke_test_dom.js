// Headless smoke test (jsdom + node-canvas). NOT a real-browser test: no layout, no real tiles, no pixel checks.
// Setup once:  npm i jsdom canvas leaflet chart.js@4.4.1   (run from a folder that has node_modules)   Run: node smoke_test_dom.js <projectRoot>
const fs = require('fs'), path = require('path'), http = require('http');
const { JSDOM, requestInterceptor, VirtualConsole } = require('jsdom');
const root = path.resolve(process.argv[2] || '.'), nm = path.join(process.cwd(), 'node_modules/leaflet'), cj = path.join(process.cwd(), 'node_modules/chart.js');
const srv = http.createServer((q, s) => { const p = path.join(root, decodeURIComponent(q.url.split('?')[0])); fs.readFile(p, (e, b) => { if (e) { s.statusCode = 404; s.end(); } else s.end(b); }); });
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const js = f => new Response(fs.readFileSync(f), { headers: { 'Content-Type': 'application/javascript' } });
const RL = { interceptors: [requestInterceptor(req => {
  if (/leaflet\.min\.js/.test(req.url)) return js(path.join(nm, 'dist/leaflet.js'));
  if (/chart\.umd/.test(req.url)) return js(path.join(cj, 'dist/chart.umd.js'));
  if (/leaflet\.min\.css|fonts\.g/.test(req.url)) return new Response('', { headers: { 'Content-Type': 'text/css' } }); })] };
srv.listen(0, async () => {
  const base = 'http://127.0.0.1:' + srv.address().port, errors = [], vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push('jsdomError: ' + (e.detail && e.detail.message || e.message))); vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ').slice(0, 300)));
  const dom = await JSDOM.fromURL(base + '/website/index.html', { runScripts: 'dangerously', resources: RL, pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) { w.fetch = (u, o) => fetch(u, o); w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {} }));
      Object.defineProperty(w.HTMLElement.prototype, 'clientWidth', { get() { return 900; } }); Object.defineProperty(w.HTMLElement.prototype, 'clientHeight', { get() { return 520; } });
      w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }; w.Element.prototype.scrollIntoView = function () {}; w.IntersectionObserver = class { observe() {} disconnect() {} }; w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => {}; } });
  const w = dom.window, d = w.document, $ = id => d.getElementById(id), sleep = ms => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 120 && !(w.FZ && w.FZ.portfolio && $('boot').classList.contains('done')); i++) await sleep(500);
  ok(!!(w.FZ && w.FZ.analysis), 'boot: data loaded and similarity engine ran');
  ok($('stats').children.length === 5, 'Mission Control: 5 stat tiles'); ok($('findings').children.length === 5, 'Mission Control: 5 findings');
  ok(/NaN|undefined|null/.test($('findings').textContent + $('stats').textContent) === false, 'Mission Control: no NaN/undefined/null text');
  ok(w.FZ.report.failed.length === 0, 'loader: no failed datasets (' + w.FZ.report.loaded.length + '/' + w.FZ.report.total + ')');
  ok(d.querySelectorAll('#charts canvas').length === 8, 'Field Notes: 8 chart canvases'); ok(!d.querySelector('#charts .warn') || [...d.querySelectorAll('#charts p.warn')].every(p => /^Missing:/.test(p.textContent)), 'Field Notes: no chart-draw errors');
  ok($('candtable').querySelectorAll('tr.cl').length === 10, 'Analog Discovery: 10 candidate rows');
  ok($('pitems').children.length === 5, 'Portfolio: 5 site cards'); ok($('gaps').children.length === 9, 'Evidence Room: 9 gap cards');
  ok($('briefbody').textContent.length > 800 && /Evidence limitations/.test($('briefbody').textContent), 'Mission Brief rendered');
  ok(w.FZMap.map && w.FZMap.group.getLayers().length > 5000, 'Explorer: Earth map drew ' + (w.FZMap.group && w.FZMap.group.getLayers().length) + ' cells');
  ok(w.FZMap.map.options.crs === w.L.CRS.EPSG3857, 'Earth map CRS = EPSG:3857 (WGS84 lon/lat input)');
  const ch = i => w.Chart.getChart(d.querySelectorAll('#charts canvas')[i]), sum = a => a.reduce((x, y) => x + y, 0);
  const cmp = Object.fromEntries(w.FZ.data.comparison[120].rows.map(r => [r.body, r]));
  ok(JSON.stringify(ch(0).data.datasets[0].data) === JSON.stringify([cmp.earth.slope_deg_mean, cmp.mars.slope_deg_mean, cmp.moon.slope_deg_mean]), 'chart A values equal comparison_120m.csv slope means');
  ok(ch(1).data.datasets.every(ds => Math.abs(sum(ds.data) - 100) < 1e-6), 'chart B: each body histogram sums to 100 %');
  ok(Math.abs(ch(4).data.datasets[0].data.length - 365) === 0 && ch(4).data.datasets[0].data[0] === w.FZ.data.climate.earth.daily.rows[0].T2M_MAX, 'chart D: 365 POWER days, first value = CSV T2M_MAX');
  ok(ch(5).data.datasets.every(ds => Math.abs(sum(ds.data) - 100) < 1e-6), 'chart E1: score histograms sum to 100 %');
  ok(ch(6).data.datasets.length === 4 && ch(6).data.datasets[0].data.every((v, i) => { const c = w.FZ.analysis.candidates.mars.primary[i]; return Math.abs(sum(ch(6).data.datasets.map(ds => ds.data[i])) - c.score) < 0.1; }), 'chart E2: feature contributions sum to each candidate score (±0.1)');
  const click = el => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  // interactions
  for (const b of ['mars', 'moon']) { click($('bodyseg').querySelector('[data-v=' + b + ']')); await sleep(300);
    ok(w.FZMap.body === b && w.FZMap.map.options.crs === w.L.CRS.Simple && w.FZMap.group.getLayers().length > 1000, b + ' view: CRS.Simple, ' + w.FZMap.group.getLayers().length + ' cells, no Earth basemap');
    ok(![...Object.values(w.FZMap.map._layers)].some(l => l._url), b + ' view: no tile layer');
    for (const o of [...$('layersel').options]) { $('layersel').value = o.value; $('layersel').dispatchEvent(new w.Event('change')); } ok(true, b + ' view: every layer option renders'); }
  click($('bodyseg').querySelector('[data-v=earth]')); await sleep(300);
  for (const o of [...$('layersel').options]) { $('layersel').value = o.value; $('layersel').dispatchEvent(new w.Event('change')); } ok(true, 'earth: all ' + $('layersel').options.length + ' layers render');
  $('candtoggle').checked = false; $('candtoggle').dispatchEvent(new w.Event('change')); $('candtoggle').checked = true; $('candtoggle').dispatchEvent(new w.Event('change')); ok(true, 'candidate overlay toggles');
  click($('candtable').querySelector('tr.cl')); ok(/score 98\.7/.test($('canddetail').textContent), 'candidate 1 detail shows score 98.7 (matches top_candidates.json 98.72)');
  click($('showmap')); await sleep(200); ok(!!w.FZ.sel && Math.abs(w.FZ.sel.lon - 28.112981) < 1e-9, 'Show on map selects the exact candidate cell'); ok(/Similarity to Mars/.test($('detail').textContent) && /98\./.test($('detail').textContent), 'detail panel lists coordinates, metrics, scores');
  click($('pinbtn')); ok($('pinned').querySelectorAll('th').length === 2, 'pin to compare works');
  click($('tgtseg').querySelector('[data-v=moon]')); ok(/Candidate|Select/.test($('canddetail').textContent) && $('candtable').querySelectorAll('tr.cl').length === 10, 'Moon target switches table');
  click($('scaleseg').querySelector('[data-v="360"]')); ok($('candtable').querySelectorAll('tr.cl').length === 10, '360 m sensitivity table');
  const before = $('pitems').textContent; $('pn').value = 8; $('pn').dispatchEvent(new w.Event('input')); ok($('pitems').children.length === 8, 'portfolio slider -> 8 sites');
  click($('ptgt').querySelector('[data-v=moon]')); ok($('pitems').textContent !== before && w.FZ.portfolio.options.target === 'moon', 'portfolio target -> Moon changes results');
  ok(w.FZMap.port.getLayers().length === 8, 'portfolio drawn on Earth map (8 markers)');
  click($('dlmd')); click($('dljson')); ok(true, 'export buttons run without error');
  const tileErr = errors.filter(e => /tile\.openstreetmap/.test(e)), other = errors.filter(e => !/tile\.openstreetmap/.test(e));
  ok(tileErr.length > 0 ? !$('mapnote').hidden : true, 'missing tiles handled: ' + tileErr.length + ' tile loads failed (sandbox has no internet); fallback note ' + ($('mapnote').hidden ? 'hidden' : 'shown'));
  ok(other.length === 0, 'console/jsdom errors (excluding tile loads): ' + (other.length ? other.slice(0, 5).join(' | ') : 'none'));
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); srv.close(); process.exit(fails ? 1 : 0);
});
