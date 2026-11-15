# FIELD//ZERO scientific analysis notes (Field Notes chapter)

Code: `website/js/charts.js` (Chart.js). Every series is read from the loaded project data; nothing is generated.

| Chart | Data used | Notes |
|---|---|---|
| A Terrain comparison | `Data/processed/comparison_120m.csv` (means and SDs of full 120 m grids) | Slope, roughness, elevation variability, TRI. Absolute elevation is deliberately excluded (different vertical datums). |
| B Distributions | decimated 120 m GeoJSON of each body (Earth 2800, Mars 3905, Moon 3300 cells; null border cells dropped) | Shared bins from 0 to the pooled 99th percentile, y = % of valid cells. Decimated samples, so shapes are indicative; full-grid statistics are in the summaries. Same-sample basis keeps the three bodies comparable. |
| C Resolution | engine `scale_comparison`, `*_terrain_summary.json` (120 m and 360 m) | Only 44 % (Mars) and 63 % (Moon) of 120 m cells score within 15 points of their 360 m parent; Spearman 0.55 and 0.70. Several top candidates are flagged divergent. Scores are scale-dependent and source DEM resolutions differ (20 m, 30 m, 118 m), so smoothing differs by body. |
| D Climate | `earth_western_desert_power_daily.csv` + summary (365 days, 2023, one grid point) | Variables present: T2M_MAX, T2M_MIN, ALLSKY_SFC_SW_DWN, WS2M, PS. T2M is missing and is not derived. POWER is modelled/satellite-derived, not station data. No Mars or Moon climate exists in the project. |
| E Similarity | engine per-cell scores and top candidates | Score histograms, per-feature contributions (sum to the score), 120 m vs 360 m scores of top candidates. |

Scientific assumptions are those of `metadata/SIMILARITY_METHODOLOGY.md`: scores measure statistical closeness of four terrain-shape metrics to one reference site per body, nothing more.
