'use strict';
/* Shared Node helpers: load the real processed datasets (via the project's own data-loader CSV parser). */
const fs = require('fs');
const path = require('path');
const Loader = require('../website/js/data-loader.js');

const ROOT = path.resolve(__dirname, '..');
const DIRS = { earth: 'Earth files', mars: 'Mars files', moon: 'Moon files' };
const SITES = { earth: 'earth_western_desert', mars: 'mars_jezero', moon: 'moon_taurus_littrow' };

function terrainPath(body, scale, kind) {
  const f = SITES[body] + '_' + scale + 'm_terrain' + (kind === 'summary' ? '_summary.json' : '.csv');
  return path.join(ROOT, 'Data', 'processed', DIRS[body], f);
}
function readSummary(body, scale) { return JSON.parse(fs.readFileSync(terrainPath(body, scale, 'summary'), 'utf8')); }
function readRows(body, scale) {
  const text = fs.readFileSync(terrainPath(body, scale, 'csv'), 'utf8');
  const t = Loader.util.parseCsv(text, { numericColumns: ['x_m_localTM', 'y_m_localTM', 'lon_deg', 'lat_deg', 'elevation', 'slope_deg', 'aspect_deg', 'roughness_std', 'elev_variability_std', 'tri'], stringColumns: ['site'] });
  return t.rows;
}
/** inputs for engine.analyze. withRefRows adds reference cell rows (validation only; the model never reads them). */
function loadInputs(withRefRows) {
  const inputs = {};
  ['earth', 'mars', 'moon'].forEach((b) => {
    inputs[b] = {};
    [120, 360].forEach((sc) => {
      inputs[b][sc] = { summary: readSummary(b, sc), rows: (b === 'earth' || withRefRows) ? readRows(b, sc) : null };
    });
  });
  return inputs;
}
module.exports = { ROOT, terrainPath, readSummary, readRows, loadInputs };
