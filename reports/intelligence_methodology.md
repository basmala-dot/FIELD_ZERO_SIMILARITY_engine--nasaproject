# FIELD//ZERO mission intelligence: methodology

Code: `website/js/mission-intelligence.js` (pure computation, runs in browser and Node). Outputs: `outputs/mission_portfolio.json`, `outputs/evidence_gaps.json` (regenerate with `node scripts/run_intelligence.js`).

## Module A: Mission Portfolio Optimizer
Input: the similarity engine's per-cell results (never recomputed) joined by row index to the Earth 120 m terrain CSV (which supplies lon/lat and local transverse-Mercator x/y in metres).

**Eligible cells:** status `scored`, completeness >= 0.7, all four terrain features present. Pool = the top 3000 eligible cells by score.

**Objective (greedy, deterministic):** at each step pick the pool cell maximising
`gain = 0.5 * score/100 + 0.3 * min(1, d_terrain / 1.0) + 0.2 * completeness`
subject to a hard minimum separation (default 2000 m, user adjustable 1-6 km) to every selected site.
- `score`: engine overall score (0-100), reused unchanged.
- `d_terrain`: Euclidean distance to the nearest already-selected site in a 4-D space of `log1p(slope, roughness, elevation variability, TRI)`, each axis divided by its standard deviation over all eligible cells. 1.0 = one SD of Earth terrain variation. The first pick has no neighbours, so it is the highest-scoring cell.
- `completeness`: engine completeness (share of feature weight present).
- Ties break on the lowest CSV row index. There is no randomness, so identical inputs give identical output.

**Reported comparison:** mean score and mean pairwise terrain distance of the portfolio versus the plain top-N scores (no separation, no diversity). In the generated files the top-N picks are almost identical terrain (mean pairwise distance 0.13 Mars / 0.08 Moon) while the 5-site portfolios reach 1.18 / 1.31 at a cost of roughly 10 to 12 points of mean score.

**Limitations:** greedy, not globally optimal; weights are expert judgement, not fitted; only four DEM-derived metrics (no geology, composition, regolith, illumination, temperature, gravity); search is restricted to the Western Desert window in the processed data and to the top-3000 pool; neighbouring cells share smoothing kernels so 2 km separation does not guarantee independent terrain; 120 m and 360 m scores often disagree (see Field Notes). Selected sites are terrain-metric candidates, not confirmed analogs.

## Module B: Evidence Gap Detector
`evidenceGaps(data)` derives each status from what is actually loaded (e.g. it checks the POWER column list for `T2M`; it checks whether a Mars or Moon climate dataset exists). Statuses: Available, Partially available, Missing, Not independently verified.

| Gap | Body | Status now | Basis |
|---|---|---|---|
| T2M daily mean | Earth | Partially available | T2M_MAX and T2M_MIN present, T2M absent (download failed per project status report); not derived |
| Lunar temperature | Moon | Missing | Diviner not processed |
| Mars climate | Mars | Missing | MEDA not processed |
| Lunar illumination | Moon | Missing | no dataset in manifest |
| Surface composition | all | Missing | not implemented |
| Soil / regolith | all | Missing | not implemented |
| Common vertical datum | all | Partially available | elevation per body, excluded from similarity |
| Reference representativeness | Mars, Moon | Not independently verified | one site each |
| Station-measured climate | Earth | Not independently verified | POWER is modelled data for one grid cell |

Recommended sources (LRO Diviner, Mars 2020 MEDA, LOLA illumination products, CRISM, Apollo sample data, NASA POWER T2M) are suggestions only. Every item carries the text "This project did not access this source." No missing value is invented.
