'use strict';
/* Generates outputs/earth_mars_similarity.geojson, outputs/earth_moon_similarity.geojson, outputs/top_candidates.json
 * from the real processed datasets using website/js/similarity-engine.js (the single source of truth).
 * Usage: node scripts/run_similarity.js [--weights slope_deg=0.3,roughness_std=0.2,elev_variability_std=0.3,tri=0.2] */
const fs = require('fs');
const path = require('path');
const E = require('../website/js/similarity-engine.js');
const IO = require('./similarity_io.js');

const userCfg = {};
const wi = process.argv.indexOf('--weights');
if (wi !== -1) {
  userCfg.weights = {};
  process.argv[wi + 1].split(',').forEach((kv) => { const [k, v] = kv.split('='); userCfg.weights[k] = Number(v); });
}
const t0 = Date.now();
const inputs = IO.loadInputs(false);
const analysis = E.analyze(inputs, userCfg);
const outDir = path.join(IO.ROOT, 'outputs');
fs.mkdirSync(outDir, { recursive: true });
['mars', 'moon'].forEach((b) => {
  const gj = E.toGeoJSON(analysis, b);
  fs.writeFileSync(path.join(outDir, 'earth_' + b + '_similarity.geojson'), JSON.stringify(gj));
});
fs.writeFileSync(path.join(outDir, 'top_candidates.json'), JSON.stringify(E.toTopCandidates(analysis), null, 2) + '\n');
['mars', 'moon'].forEach((b) => {
  const s = analysis.results[b][120].stats;
  console.log(b, '120m scored', s.n_scored, '/', s.n_cells, 'median', s.score.median.toFixed(1), 'p99', s.score.p99.toFixed(1), 'max', s.score.max.toFixed(1));
});
console.log('done in', Date.now() - t0, 'ms');
