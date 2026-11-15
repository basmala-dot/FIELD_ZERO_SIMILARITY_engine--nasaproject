# FIELD//ZERO Terrain Analog Similarity: Methodology

> **TERRAIN ANALOG MODEL. This is not proof of complete environmental equivalence.**
> It compares four DEM-derived surface-shape metrics. It says nothing about geology, composition, regolith, gravity, atmosphere, temperature, pressure, radiation or illumination. No location it ranks is a confirmed planetary analog; ranked locations are candidates for further study.

Implementation: `website/js/similarity-engine.js` (v1.0.0, browser and Node). Outputs: `outputs/earth_mars_similarity.geojson`, `outputs/earth_moon_similarity.geojson`, `outputs/top_candidates.json`. Validation: `reports/similarity_validation.md`.

## 1. What is compared

Every Earth Western Desert cell is scored against two reference terrains:

| Target | Reference site | Source (from the summary JSONs) |
|---|---|---|
| Mars | Jezero crater window | USGS Mars 2020 CTX DEM 20 m |
| Moon | Taurus-Littrow window | LRO LOLA 118 m |

- **Primary scale:** 120 m (Earth 68,944 cells). **Sensitivity scale:** 360 m (7,896 cells), scored against the 360 m references.
- Earth cells at each scale are scored only against references **at the same scale**, because the kernels are defined in metres (3x3 / 5x5 windows of the grid), so the same feature means different ground footprints at 120 m and 360 m.

### Input features (the only ones used)

| Feature | Meaning (kernel at 120 m) |
|---|---|
| `slope_deg` | 3x3 central-difference slope (240 m baseline) |
| `roughness_std` | std of elevation, 3x3 window (360 m) |
| `elev_variability_std` | std of elevation, 5x5 window (600 m) |
| `tri` | Riley Terrain Ruggedness Index, 3x3 |

### Deliberately excluded

- **Absolute elevation**: datums and zero levels differ across planets (Earth 0 to 290 m; Mars about -2900 to -1500 m; Moon about -2900 to -200 m). The engine rejects `elevation` as a feature, and a validation test (C5) confirms that shifting the elevation column by 1000 m changes no score.
- **Aspect**: circular, not a roughness measure.
- **Temperature, pressure and other POWER climate variables**: no comparable Mars/Moon measurements exist in the processed data. The engine rejects them.
- No planetary quantity is invented, imputed or assumed anywhere.

## 2. Reference distributions (from the summary JSON files only)

For each reference, scale and feature the model reads only `n, mean, std, min, max` from the `*_terrain_summary.json` files. The reference CSV cells are **not** read by the engine (they are used only by validation).

Normalisation = placing a value at its percentile **F** under the reference distribution (a dimensionless number in [0,1], so degrees and metres never meet).

Family selection (`config.distribution = auto`):

```
negMass = Phi(-mean / std)        # fraction of a Gaussian with this mean/std that would lie below 0
if negMass > 0.15:  lognormal     # strongly right-skewed against a zero bound (the Mars reference)
else:               beta          # bounded on [min, max] (the Moon reference)
```

| Family | Parameters from the summary | F(x) |
|---|---|---|
| lognormal | `sigma = sqrt(ln(1+(std/mean)^2))`, `mu = ln(mean) - sigma^2/2` | `Phi((ln x - mu)/sigma)` |
| beta | `u=(mean-min)/(max-min)`, `k = u(1-u)/(std/(max-min))^2 - 1`, `alpha=u k`, `beta=(1-u)k` | `I_t(alpha, beta)`, `t = clip((x-min)/(max-min), 0, 1)` |
| gaussian (forced only) | `mu = mean`, `sigma = std` | `Phi((x-mean)/std)` |

Why these families (evidence in `reports/similarity_validation.md`, section 5, real reference cells):

- Mars references are strongly right-skewed (skewness about 2.2-2.4). Lognormal: KS about 0.08, mean self score about 46. Gaussian: KS about 0.21.
- Moon references are only mildly skewed but have mass piled near zero. A Gaussian with the Moon mean/std puts about 12% of its mass below zero, so flat terrain could never score below about 25 against the Moon. The Beta on [min, max] removes that defect (KS 0.08-0.09 versus 0.14).
- The first version of this model used Gaussian here, and it failed its own validation (see the validation report's "Design history"). The family rule is **calibrated on two references**; the 0.15 threshold sits between the observed Moon values (0.12) and Mars values (0.18-0.22). Any new reference site needs re-validation.

## 3. Scoring formulas

For Earth cell value `x` of feature `i`, with reference percentile `F_i`:

```
Feature score    s_i = 100 * (1 - |2 F_i - 1|) = 200 * min(F_i, 1 - F_i)      0..100
                       (for z-score families this equals 100 * erfc(|z_i| / sqrt 2))
Overall score    S   = sum_i( w_i * s_i ) / sum_i( w_i )                       over features present
Contribution     c_i = ( w_i / W_available ) * s_i                             sum_i c_i = S
Shortfall        d_i = ( w_i / W_available ) * ( 100 - s_i )                   points lost to feature i
Completeness     q   = W_available / W_total                                   0..1
```

Meaning of a feature score: the share of the reference distribution that is **at least as far from the reference median** as this cell value (a two-sided tail probability, x100). 100 is the reference median; 20 is the 10th/90th percentile; 5 is the 2.5th/97.5th percentile; 0 means at or beyond the observed reference extreme (Beta) or the far tail. It is a **typicality** score, not a probability of being an analog.

The feature with the largest shortfall is reported as `limiting_feature`: it is the feature costing the cell the most points.

### Weights (configurable)

Default (normalised to sum 1, set in `DEFAULT_CONFIG.weights` or passed to `analyze(inputs, { weights })`):

| Feature | Weight | Rationale |
|---|---:|---|
| `slope_deg` | 0.30 | Gradient; the primary descriptor of terrain steepness |
| `elev_variability_std` | 0.30 | Broad-window (600 m) relief; the only feature at a larger footprint |
| `roughness_std` | 0.20 | Local relief |
| `tri` | 0.20 | Local ruggedness; near-duplicate of `roughness_std` |

`roughness_std` and `tri` get 0.40 together, i.e. one "local ruggedness" group, because they are almost the same information (Spearman 0.95 on Earth, 0.99 on Mars, 1.00 on the Moon). **These weights are expert judgement, not fitted to any data.** Their influence is measured (equal weights, slope-heavy, relief-heavy and leave-one-out in validation section 6). Weights must be non-negative, are normalised, and invalid sets are rejected. A weight of 0 removes a feature.

## 4. Missing values

Handled explicitly and never filled:

1. A feature value that is null, undefined, NaN or non-finite is **missing**. A negative value is **invalid** (these metrics are non-negative). Both are excluded from that cell's score.
2. The weights of excluded features are removed and the remaining weights are renormalised for that cell. The cell's `completeness` records the weight share that was available.
3. A cell is scored only if `completeness >= 0.5` **and** at least 2 features are present. Otherwise `score`, `rank` and the per-feature fields are `null` and confidence is `insufficient`. A missing score is never written as 0.
4. In the real data this arises at the window edge: 1,048 Earth 120 m cells have all four features missing (not scored); 1,040 cells lack only `elev_variability_std` (5x5 kernel) and are scored on three features with completeness 0.70.

## 5. Confidence and data completeness

Per cell: `completeness` (above) and `confidence`:

| Class | Rule |
|---|---|
| `high` | all four features present **and** the containing 360 m cell's score is within 15 points of the 120 m score (`scale_consistency = consistent`) |
| `medium` | all features present but scale divergent or not assessable; or completeness >= 0.70 with scale consistent |
| `low` | scored but weaker than the above (for example partial data with a divergent or missing 360 m check) |
| `insufficient` | not scored |

360 m cells have no coarser scale to check against, so they reach at most `medium`. Additionally `n_outside_ref_range` counts features whose value lies outside the observed reference [min, max]. Confidence describes data completeness and scale stability, **not** scientific certainty that the terrain is an analog.

## 6. 120 m versus 360 m comparison

Both Earth grids lie on one local-transverse-Mercator lattice (verified: identical lon/lat at all 7,544 shared lattice points), and each 360 m cell contains up to 3x3 cells of 120 m. For every 120 m cell the output carries `score_360m` (its parent's score), `delta_360m = score_120 - score_360` and `scale_consistency`. `top_candidates.json` also reports parent-level Spearman and Pearson correlations, the share of consistent cells, and the overlap of the top 5% of cells.

This is a **sensitivity analysis** of kernel footprint and resampling. It is not independent validation: both scales come from the same source DEMs.

## 7. Ranked candidate locations

1. Rank scored cells by overall score (1 = best). Ties broken by completeness, then row order.
2. Candidate eligibility: completeness = 1 (all features present).
3. Greedy selection of the top 10 with a minimum separation of 2,000 m (Euclidean distance in local-TM metres), because neighbouring cells share kernel windows and are not independent evidence.
4. Each candidate records the raw value, reference centre, z-score (where defined), reference percentile, feature score, effective weight, contribution and shortfall for every feature, plus its 360 m check. Every candidate carries the label "Terrain-metric similarity candidate. Not a confirmed analog."

## 8. Assumptions

1. Terrain metrics can be compared across planets **after normalisation to each reference's own distribution**.
2. The Jezero and Taurus-Littrow windows in the processed data stand for "the reference terrain". They are single sites, not "Mars" or "the Moon".
3. Summary statistics suffice to describe a reference distribution (moment-matched approximation, quantified in validation).
4. Feature kernels are the same in metres on every body (recorded in each summary's `kernels_m`).
5. Default weights are expert judgement.

## 9. Limitations

- **Not environmental equivalence.** Four terrain-shape metrics only.
- **Collinear features.** Spearman correlation among the four features is 0.75-1.00 in all six terrain tables. The model effectively measures one ruggedness axis; four features are not four independent pieces of evidence.
- **Low discriminating power.** Even a score built from the full empirical reference distribution separates Mars-site cells from Moon-site cells only with AUC of about 0.54-0.68. A high Mars score does not mean the cell is "more Mars-like than Moon-like".
- **Scale dependence.** 120 m and 360 m results agree only moderately (Mars: about 44% of cells consistent, parent-level Spearman about 0.55; Moon: about 63%, 0.70). Mean roughness grows 2.45x (Mars reference) and 2.89x (Moon reference) from 120 m to 360 m but only 1.52x on Earth, so part of the disagreement is real scale-dependent behaviour.
- **Source-resolution differences.** The Moon grid (118 m native) is barely smoothed at 120 m; Mars (20 m) and Earth (about 30 m) are area-averaged.
- **Calibration.** Self-score means are 44-50 against an ideal 50, and Earth scores differ from empirical-distribution scores by about 2-15 points on average; rank order is reproduced closely (Spearman >= 0.98). Treat absolute score values as approximate. Validation is in-sample for the family choice.
- **Sensitivity of candidate lists.** Rank order is stable to weights, but the identity of the top-1% cells changes noticeably with weights and a lot with the distribution family. Use candidate lists as a shortlist, not a result.
- **The Earth window is smoother than both references** (about 20-30% of Earth cells lie below the Mars 10th percentile and about 45-68% below the Moon 10th percentile). High scores are the rough tail of this window. Scores are relative to this window, not to all of Earth.
- **Edge cells** are partially or wholly unscored.
- **No ground truth.** No labelled analog sites exist in the inputs, so the model is validated for correctness, calibration and consistency, not for scientific validity as an analog finder.
- **Mars/Moon lon/lat in the inputs are not WGS84** (per the project manifest); the model never uses them. Output coordinates are Earth WGS84.

## 10. Output file schema

`earth_{mars,moon}_similarity.geojson`: FeatureCollection of 68,944 Points in the same order as the 120 m Earth CSV; foreign member `metadata` holds the label, disclaimer, formulas, config, weights, reference statistics and model parameters, and score statistics. Per-cell properties:

| Property | Meaning |
|---|---|
| `rank` | 1 = best among scored cells; `null` if not scored |
| `score` | overall score 0-100 or `null` |
| `confidence`, `completeness`, `n_features_used`, `n_outside_ref_range`, `limiting_feature` | data and explanation indicators |
| `fs_<feature>` | feature score (1 decimal) |
| `c_<feature>` | contribution in overall points (2 decimals); sums to `score` |
| `score_360m`, `delta_360m`, `scale_consistency` | 360 m comparison |

z-scores and x/y are not stored per cell, to limit file size (about 33 MB each); they are in `top_candidates.json` for candidates, and x/y are in the 120 m CSV (same row order).

`top_candidates.json`: model label, config, candidate rules, reference parameters, statistics, scale-comparison statistics, 10 candidates per target at 120 m with full feature explanations, and the 10 top 360 m sensitivity candidates.

## 11. Reproduce

```
node scripts/run_similarity.js            # generates the three outputs
python3 scripts/crosscheck_similarity.py  # independent numpy/scipy re-implementation
node scripts/validate_similarity.js       # all tests, writes reports/similarity_validation.md
```

Custom weights: `node scripts/run_similarity.js --weights slope_deg=0.4,roughness_std=0.2,elev_variability_std=0.2,tri=0.2`. In the browser: `FieldZeroSimilarity.analyzeLoaded(FieldZeroData.data, { weights: {...} })` after loading the terrain CSV and summary datasets.
