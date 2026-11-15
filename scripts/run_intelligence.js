// Generates outputs/mission_portfolio.json and outputs/evidence_gaps.json and runs checks.
// Usage (project root): node scripts/run_intelligence.js   (serves nothing; reads files via a temporary local server if none given)
const fs = require('fs'), path = require('path'), http = require('http');
const root = path.join(__dirname, '..');
const D = require('../website/js/data-loader.js'), S = require('../website/js/similarity-engine.js'), I = require('../website/js/mission-intelligence.js');
const srv = http.createServer((q, s) => { const p = path.join(root, decodeURIComponent(q.url.split('?')[0])); fs.readFile(p, (e, b) => { if (e) { s.statusCode = 404; s.end(); } else s.end(b); }); });
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
srv.listen(0, async () => {
  const base = 'http://127.0.0.1:' + srv.address().port;
  await D.init({ manifestUrl: base + '/website/site_manifest.json' }); await D.loadAll();
  await D.load('earth_120m_terrain_csv'); await D.load('earth_360m_terrain_csv');
  const a = S.analyzeLoaded(D.data), rows = D.data.terrain.earth[120].csv.rows;
  const top = JSON.parse(fs.readFileSync(path.join(root, 'outputs/top_candidates.json')));
  ok(Math.abs(a.candidates.mars.primary[0].score - top.targets.mars.candidates_120m[0].score) < 0.01, 'engine in Node reproduces stored top Mars candidate score');
  const out = { generated_by: 'scripts/run_intelligence.js', deterministic: true, portfolios: {} };
  for (const t of ['mars', 'moon']) {
    const p1 = I.portfolio(a, rows, { target: t, n: 5 }), p2 = I.portfolio(a, rows, { target: t, n: 5 });
    ok(JSON.stringify(p1) === JSON.stringify(p2), t + ': portfolio is reproducible (two runs identical)');
    ok(p1.items.length === 5, t + ': returns 5 sites');
    let minD = Infinity; p1.items.forEach((x, i) => p1.items.slice(i + 1).forEach(y => minD = Math.min(minD, Math.hypot(x.x_m_localTM - y.x_m_localTM, x.y_m_localTM - y.y_m_localTM))));
    ok(minD >= 2000, t + ': min pairwise separation ' + Math.round(minD) + ' m >= 2000 m');
    ok(p1.items.every(x => x.score === +a.results[t][120].cells[x.csv_row_index].score.toFixed(2)), t + ': scores equal engine cell scores (not recomputed)');
    ok(p1.items.every(x => Math.abs(x.lon_deg - rows[x.csv_row_index].lon_deg) < 1e-9), t + ': coordinates equal CSV row coordinates');
    const c = p1.comparison_to_top_scores_only; console.log('   ', t, JSON.stringify(c));
    out.portfolios[t] = p1;
  }
  const g = I.evidenceGaps(D.data);
  const t2m = g.items.find(x => x.id === 'earth_t2m');
  ok(t2m.status === 'Partially available' && !D.data.climate.earth.daily.columns.includes('T2M'), 'T2M detected as not present (T2M_MAX/T2M_MIN only)');
  ok(g.items.every(x => x.source_access.includes('did not access')), 'no gap claims a source was accessed');
  out.note = 'Terrain-metric candidates only. Not confirmed analogs.';
  fs.writeFileSync(path.join(root, 'outputs/mission_portfolio.json'), JSON.stringify(out, null, 1));
  fs.writeFileSync(path.join(root, 'outputs/evidence_gaps.json'), JSON.stringify(g, null, 1));
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); srv.close(); process.exit(fails ? 1 : 0);
});
