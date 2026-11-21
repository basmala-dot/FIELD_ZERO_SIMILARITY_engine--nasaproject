/*!
 * FIELD//ZERO mission model  (v1.0.0)
 *
 *   Mission configuration, data models, input validation, constraints and resource definitions
 *   for the FIELD//ZERO Mission Intelligence & Planning Engine (website/js/mission-engine.js).
 *
 * This file is PURE DEFINITIONS + VALIDATION. It computes no similarity, suitability, risk or route.
 * It has no dependency on any other project file, and works in browsers
 * (<script src="js/mission-model.js"> -> window.FieldZeroMissionModel) and Node 18+ (require).
 *
 * HONESTY RULES BUILT INTO THIS MODEL
 *   1. Every default value carries a `basis` tag saying what it is:
 *        project_data            read from a project dataset (never defaulted here)
 *        external_constant       a published physical constant that is NOT in the project datasets
 *        assumption              an engineering / expert-judgement value chosen by the team, not measured
 *        placeholder             a generic stand-in for a user-supplied vehicle or mission value
 *        heuristic               a transparent formula weight, not fitted to data
 *      Nothing tagged assumption / placeholder / heuristic may be presented as a scientific measurement.
 *   2. No default is invented for a budget (time, energy, distance). Unset budgets stay null and the
 *      engine reports "not evaluated" instead of pretending a limit exists.
 *   3. No real vehicle is modelled. There are no rover presets, because their specifications are not in
 *      the project data and must not be guessed.
 *   4. Validation never silently repairs a value. It reports errors (value unusable) and warnings
 *      (value usable but suspicious), and lists every default it applied.
 *
 * CONSUMERS
 *   Person 2 (frontend):  validateMissionConfig() for form checking, DATA_LIMITATIONS / STRATEGIES for labels,
 *                         SECTION_KEYS and OUTPUT_CONTRACT to know the result shape.
 *   Person 3 (simulation): validateLocation(), analyzeGrid(), SIMULATION_SCHEMA for the exported scenario shape.
 *   mission-engine.js:     everything.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FieldZeroMissionModel = factory();
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function () {
  'use strict';

  var VERSION = '1.0.0';
  var SCHEMA_VERSION = '1.0';

  // ------------------------------------------------------------------ provenance tags
  var BASIS = {
    project_data: 'Read from a FIELD//ZERO processed dataset.',
    model_output: 'Output of the project similarity model (FieldZeroSimilarity), reused unchanged.',
    external_constant: 'Published physical constant that is not part of the project datasets.',
    assumption: 'Engineering or expert-judgement value chosen by the team. Not measured, not fitted.',
    placeholder: 'Generic stand-in for a value the user should supply (for example a vehicle parameter).',
    heuristic: 'Transparent formula or weight. Not calibrated against ground truth.',
    estimate: 'Computed from assumptions and placeholders. An estimate, not a measurement or a prediction.',
    user_input: 'Supplied by the person configuring the mission.'
  };

  var LABEL = 'TERRAIN ANALOG + PLANNING MODEL: terrain-metric similarity (four DEM-derived metrics), heuristic suitability ' +
    'and risk indices, and route time/energy ESTIMATES built on assumptions. Not a confirmed analog, not flight-qualified.';

  // ------------------------------------------------------------------ bodies
  // Gravity and radius are EXTERNAL reference constants (not in the project datasets). They are used only by
  // the route energy estimate (gravity) and by great-circle keep-out zones (radius). Radii are the same values
  // the project's map.js uses for display.
  var BODIES = {
    earth: {
      id: 'earth', label: 'Earth · Western Desert', site: 'earth_western_desert', role: 'analog_search_domain',
      coordinate_system: 'WGS84 lon/lat', wgs84: true,
      gravity: { value: 9.80665, unit: 'm/s^2', basis: 'external_constant', source: 'Standard gravity (CGPM 1901 / ISO 80000-3). Not in the project datasets.' },
      radius_m: { value: 6371008.8, basis: 'external_constant', source: 'IAU/IUGG mean radius. Not in the project datasets.' }
    },
    mars: {
      id: 'mars', label: 'Mars · Jezero Crater', site: 'mars_jezero', role: 'reference_target',
      coordinate_system: 'Mars sphere lon/lat (GCS_Mars_2000_Sphere), NOT WGS84', wgs84: false,
      gravity: { value: 3.71, unit: 'm/s^2', basis: 'external_constant', source: 'NASA Mars fact sheet, rounded. Not in the project datasets.' },
      radius_m: { value: 3396190, basis: 'external_constant', source: 'IAU mean radius (as used by website/js/map.js).' }
    },
    moon: {
      id: 'moon', label: 'Moon · Taurus-Littrow', site: 'moon_taurus_littrow', role: 'reference_target',
      coordinate_system: 'Moon sphere lon/lat (R = 1737.4 km), NOT WGS84', wgs84: false,
      gravity: { value: 1.62, unit: 'm/s^2', basis: 'external_constant', source: 'NASA Moon fact sheet, rounded. Not in the project datasets.' },
      radius_m: { value: 1737400, basis: 'external_constant', source: 'IAU mean radius (as used by website/js/map.js).' }
    }
  };
  var TARGET_BODIES = ['mars', 'moon'];
  var ALL_BODIES = ['earth', 'mars', 'moon'];
  var SCALES = [120, 360];
  var SITE_SCALE_M = 120;      // site assessment and ranking always use the primary 120 m scale

  // Terrain columns the planner reads. The similarity features must equal FieldZeroSimilarity.ALLOWED_FEATURES
  // (the engine asserts this at start-up instead of trusting a copy).
  var FEATURE_COLUMNS = ['slope_deg', 'roughness_std', 'elev_variability_std', 'tri'];
  var TERRAIN_COLUMNS = ['x_m_localTM', 'y_m_localTM', 'lon_deg', 'lat_deg', 'elevation'].concat(FEATURE_COLUMNS);
  var FEATURE_INFO = {
    slope_deg: { label: 'Slope', unit: 'deg' },
    roughness_std: { label: 'Roughness (local std of elevation)', unit: 'm' },
    elev_variability_std: { label: 'Elevation variability (broad-window std)', unit: 'm' },
    tri: { label: 'Terrain Ruggedness Index (Riley)', unit: 'm' }
  };

  var STRATEGY_IDS = ['FAST', 'SAFE', 'SCIENTIFIC'];
  var SECTION_KEYS = ['similarity', 'suitability', 'risk', 'confidence', 'data_limitations'];

  // ------------------------------------------------------------------ parameter specifications
  // One table drives defaults, validation, UI hints and the assumptions list.
  function P(def, min, max, unit, basis, desc, extra) {
    var s = { def: def, min: min, max: max, unit: unit, basis: basis, desc: desc };
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) s[k] = extra[k];
    return s;
  }
  var SPECS = {
    rover: {
      // Generic placeholder vehicle. It is NOT any real rover. Replace every value with the vehicle being studied.
      massKg: P(150, 1, 5000, 'kg', 'placeholder', 'Vehicle mass. Used by the energy estimate.'),
      nominalSpeedMps: P(0.5, 0.001, 5, 'm/s', 'placeholder', 'Driving speed on flat ground.'),
      rollingResistance: P(0.15, 0.01, 0.6, '-', 'placeholder', 'Rolling-resistance coefficient (soil dependent; soil is not in the data).'),
      drivetrainEfficiency: P(0.6, 0.05, 1, '-', 'placeholder', 'Battery-to-wheel efficiency.'),
      basePowerW: P(40, 0, 5000, 'W', 'placeholder', 'Constant housekeeping power draw while the mission clock runs.'),
      minSpeedFactor: P(0.3, 0.05, 1, '-', 'assumption', 'Speed multiplier at the slope limit; speed falls linearly from 1.0 on flat ground.')
    },
    resources: {
      // Budgets default to null: the engine then reports "not evaluated". No budget is ever invented.
      timeBudgetH: P(null, 0.01, 1e5, 'h', 'user_input', 'Operating-time budget for the whole mission (driving + site dwell).', { nullable: true }),
      energyBudgetWh: P(null, 1, 1e8, 'Wh', 'user_input', 'Usable battery energy. Solar recharge is not modelled.', { nullable: true }),
      energyReserveFraction: P(0.2, 0, 0.9, '-', 'assumption', 'Share of the energy budget held back as reserve.'),
      maxTotalDistanceM: P(null, 1, 1e7, 'm', 'user_input', 'Maximum total driving distance.', { nullable: true })
    },
    constraints: {
      maxSlopeDeg: P(15, 1, 45, 'deg', 'assumption', 'Hard slope limit (terrain gradient and travel grade). Set this to the vehicle limit.', { warnAbove: 30 }),
      maxRoughnessM: P(null, 0.01, 1000, 'm', 'user_input', 'Hard limit on roughness_std (m, window-dependent). Null = roughness is a soft cost only.', { nullable: true }),
      minCompleteness: P(1, 0.5, 1, '-', 'assumption', 'Minimum similarity-feature completeness for a site to be eligible (1 = all four metrics present).'),
      minSimilarityScore: P(0, 0, 100, 'score', 'user_input', 'Minimum similarity score for a site to be eligible (0 = no filter).'),
      minSeparationM: P(2000, 0, 50000, 'm', 'assumption', 'Minimum spacing between selected sites (neighbouring cells share smoothing kernels).'),
      neighbourhoodRadiusM: P(1000, 120, 10000, 'm', 'assumption', 'Radius of the window used for suitability and risk context around a site.'),
      stagingSearchRadiusM: P(5000, 0, 50000, 'm', 'assumption', 'When no start is given, the engine proposes a staging cell within this distance of the best-matching site.')
    },
    objectives: {
      numSites: P(5, 1, 12, 'sites', 'user_input', 'Ranked candidate sites returned per strategy.', { integer: true }),
      numScienceStops: P(3, 1, 6, 'sites', 'user_input', 'Sites visited by the SCIENTIFIC tour (FAST and SAFE visit one).', { integer: true }),
      siteDwellH: P(2, 0, 240, 'h', 'assumption', 'Time spent working at each visited site (added to mission time).')
    }
  };
  var BOOL_SPECS = { objectives: { returnToStart: { def: false, desc: 'End the tour back at the start cell.' } } };

  // ------------------------------------------------------------------ strategies
  // All numbers here are DESIGN CHOICES (assumption/heuristic). They define what each strategy means; they are
  // not measured values. The engine prints them with every result so a reader can see exactly what was optimised.
  //
  // Route step cost = d3 * ( wDistance + wTime * (1/speedFactor) + wEnergy * energyFactor + wRisk * K * hazard )
  //   d3 = 3-D step length, speedFactor in [minSpeedFactor,1], energyFactor = max(0, Crr*cos(t) + sin(t)) / Crr,
  //   hazard in [0,1] (see RISK). slopeLimitFactor scales the user slope limit into a stricter hard limit.
  var STRATEGIES = {
    FAST: {
      id: 'FAST', label: 'Fast', basis: 'assumption',
      intent: 'Reach and work one site as soon as possible. Only the user limits constrain the route; risk is a minor cost.',
      route: { slopeLimitFactor: 1.0, hazardBufferM: 0, weights: { distance: 0.2, time: 1.0, energy: 0.25, risk: 0.1 }, riskPenaltyK: 1 },
      sites: { weights: { similarity: 0.25, suitability: 0.30, safety: 0.10, proximity: 0.35 }, diversityWeight: 0, stops: 'one' }
    },
    SAFE: {
      id: 'SAFE', label: 'Safe', basis: 'assumption',
      intent: 'Minimise exposure to steep, rough or unknown terrain, even if the route is longer. Stricter slope limit and a hazard buffer.',
      route: { slopeLimitFactor: 0.7, hazardBufferM: 120, weights: { distance: 0.5, time: 0.2, energy: 0.2, risk: 1.0 }, riskPenaltyK: 10 },
      sites: { weights: { similarity: 0.25, suitability: 0.30, safety: 0.40, proximity: 0.05 }, diversityWeight: 0, stops: 'one' }
    },
    SCIENTIFIC: {
      id: 'SCIENTIFIC', label: 'Scientific', basis: 'assumption',
      intent: 'Visit several high-similarity sites of different terrain type in one tour, with moderate safety margins.',
      route: { slopeLimitFactor: 0.85, hazardBufferM: 0, weights: { distance: 0.3, time: 0.5, energy: 0.5, risk: 0.5 }, riskPenaltyK: 4 },
      sites: { weights: { similarity: 0.60, suitability: 0.15, safety: 0.20, proximity: 0.05 }, diversityWeight: 0.30, stops: 'numScienceStops' }
    }
  };
  // A neutral strategy used by stand-alone assessments: user limits exactly, no buffer.
  var BASE_STRATEGY = {
    id: 'BASE', label: 'Base (user limits only)', basis: 'assumption',
    intent: 'Stand-alone assessment with the user constraints applied exactly as given.',
    route: { slopeLimitFactor: 1.0, hazardBufferM: 0, weights: { distance: 1, time: 0, energy: 0, risk: 0 }, riskPenaltyK: 0 },
    sites: { weights: { similarity: 1, suitability: 0, safety: 0, proximity: 0 }, diversityWeight: 0, stops: 'one' }
  };

  // ------------------------------------------------------------------ suitability, risk, confidence definitions
  var SUITABILITY = {
    basis: 'heuristic',
    definition: 'How well a neighbourhood supports operating the configured vehicle: room to move, margin below the slope limit, and data coverage. 0-100, higher is better. Independent of how Mars-like or Moon-like the terrain is.',
    weights: { trafficability: 0.50, slope_margin: 0.25, data_coverage: 0.25 },
    components: {
      trafficability: 'Share of the neighbourhood window that is known and passable under the applied constraints.',
      slope_margin: '100 * (1 - slope / applied slope limit) at the cell.',
      data_coverage: 'Share of the neighbourhood window with known terrain metrics (cells outside the grid count as unknown).'
    }
  };
  var RISK = {
    basis: 'heuristic',
    definition: 'Terrain hazard exposure around a site. 0-100, higher is worse. A transparent index, NOT a probability of failure.',
    weights: { local_slope_hazard: 0.30, steep_terrain_exposure: 0.25, roughness_hazard: 0.20, unknown_terrain_exposure: 0.25 },
    components: {
      local_slope_hazard: '100 * min(1, (slope / user slope limit)^2) at the cell.',
      steep_terrain_exposure: '100 * share of the window whose slope exceeds nearLimitFraction of the user slope limit.',
      roughness_hazard: '100 * percentile of the cell roughness within the same terrain grid (relative to the grid, not absolute).',
      unknown_terrain_exposure: '100 * share of the window with unknown terrain metrics.'
    },
    nearLimitFraction: 0.8,
    // Per-cell hazard h in [0,1] used inside route costs: h = slope weight * min(1,(slope/limit)^2) + roughness weight * roughness percentile.
    cellHazardWeights: { slope: 0.7, roughness: 0.3 },
    classes: [[25, 'low'], [50, 'moderate'], [75, 'high'], [101, 'severe']]
  };
  var CONFIDENCE = {
    basis: 'heuristic',
    definition: 'Confidence in the terrain-metric result for this location, given data completeness and stability. It is NOT confidence that the site is a scientific analog.',
    levels: ['insufficient', 'low', 'medium', 'high'],
    // weakest-link rule: the level is set by the lowest component value
    thresholds: { high: 0.85, medium: 0.60, low: 0.30 },
    scaleConsistencyValue: { consistent: 1.0, 'n/a': 0.6, divergent: 0.45 },
    // Without any non-terrain evidence for the target body (climate, composition, ...), confidence cannot exceed this.
    ceilingWhenEvidenceMissing: 'medium'
  };

  // ------------------------------------------------------------------ data limitation registry
  // Each statement is grounded in a project document (source) or follows by construction from the grid design.
  // applies: targets (mars/moon), operating (bodies where the route is planned), levels, needs.
  function L(id, severity, category, statement, effect, affects, source, applies) {
    return { id: id, severity: severity, category: category, statement: statement, effect: effect, affects: affects, source: source, applies: applies || {} };
  }
  var DATA_LIMITATIONS = [
    L('L_FOUR_METRICS', 'critical', 'similarity',
      'Similarity compares only four DEM-derived terrain metrics (slope, roughness, elevation variability, TRI). Geology, composition, regolith, gravity, atmosphere, temperature, pressure, radiation and illumination are not represented.',
      'A high score means similar terrain shape only. It is not environmental equivalence.', ['similarity'], 'metadata/SIMILARITY_METHODOLOGY.md section 9', { operating: ['earth'] }),
    L('L_COLLINEAR', 'major', 'similarity',
      'The four metrics are strongly rank-correlated (Spearman 0.75 to 1.00 in all six terrain tables), so the score behaves like one ruggedness axis, not four independent pieces of evidence.',
      'Agreement across features is weaker evidence than it looks.', ['similarity', 'confidence'], 'metadata/SIMILARITY_METHODOLOGY.md section 9', { operating: ['earth'] }),
    L('L_LOW_DISCRIMINATION', 'major', 'similarity',
      'Even a score built from the full empirical reference distribution separates Mars-site cells from Moon-site cells only with AUC of about 0.54 to 0.68.',
      'A high Mars score does not mean a cell is more Mars-like than Moon-like.', ['similarity'], 'metadata/SIMILARITY_METHODOLOGY.md section 9', { operating: ['earth'] }),
    L('L_SINGLE_REFERENCE', 'major', 'similarity',
      'Each target is represented by one reference window (Jezero for Mars, Taurus-Littrow for the Moon). Scores describe closeness to that window, not to the whole body.',
      'Results do not generalise to other Martian or lunar terrain.', ['similarity', 'confidence'], 'reports/PROJECT_AUDIT.md section 11', { operating: ['earth'], targets: TARGET_BODIES }),
    L('L_SEARCH_WINDOW', 'major', 'selection',
      'Earth candidate sites are drawn only from the processed Western Desert terrain window, not from all of Earth and not from the whole Western Desert.',
      'The best site in this window may be a poor analog compared with places not processed.', ['similarity', 'suitability'], 'metadata/SIMILARITY_METHODOLOGY.md section 9', { operating: ['earth'] }),
    L('L_SCALE_DEPENDENCE', 'major', 'similarity',
      '120 m and 360 m scores agree only moderately (about 44% of cells consistent for Mars and about 63% for the Moon in the project validation). Roughness and variability use windows defined in metres, so values at different scales are different quantities.',
      'Scores for the same place depend on grid scale; divergent cells get lower confidence.', ['similarity', 'confidence'], 'metadata/SIMILARITY_METHODOLOGY.md sections 6 and 9', { operating: ['earth'] }),
    L('L_RESOLUTION_MISMATCH', 'minor', 'similarity',
      'Native DEM resolutions differ (Earth about 30 m, Mars 20 m, Moon 118 m) before resampling to 120 m and 360 m grids, so smoothing differs by body independent of real terrain.',
      'Part of any Earth-versus-reference difference is processing, not terrain.', ['similarity'], 'reports/PROJECT_AUDIT.md section 11', { operating: ['earth'] }),
    L('L_WEIGHTS_UNFITTED', 'minor', 'similarity',
      'Similarity feature weights are expert judgement and are not fitted to data.',
      'Rank order is stable to weights but the identity of the top 1% cells is not.', ['similarity'], 'metadata/SIMILARITY_METHODOLOGY.md section 3', { operating: ['earth'] }),
    L('L_NO_GROUND_TRUTH', 'major', 'validation',
      'No labelled analog sites exist in the inputs. The similarity model is validated for correctness and consistency, not for scientific validity as an analog finder.',
      'No result can be called a confirmed analog.', ['similarity', 'confidence'], 'metadata/SIMILARITY_METHODOLOGY.md section 9', { operating: ['earth'] }),
    L('L_EDGE_CELLS', 'minor', 'data',
      'Cells on the kernel border have missing slope, roughness and TRI (outer 1 cell) and missing elevation variability (outer 2 cells). They are unscored and treated as unknown terrain.',
      'Sites and routes cannot use the outer ring of every grid.', ['similarity', 'suitability', 'risk'], 'reports/PROJECT_AUDIT.md section 3', {}),
    L('L_CLIMATE_MARS', 'major', 'evidence',
      'No Mars climate dataset is processed (temperature, pressure, wind, solar, humidity). MEDA data are not in the project.',
      'No atmospheric or thermal analog statement can be made for Jezero.', ['similarity', 'confidence'], 'reports/PROJECT_AUDIT.md section 7', { targets: ['mars'], operating: ['earth'] }),
    L('L_CLIMATE_MOON', 'major', 'evidence',
      'No lunar temperature or illumination dataset is processed (Diviner and LOLA illumination products are not in the project).',
      'No thermal, lighting or power-availability analog statement can be made for Taurus-Littrow.', ['similarity', 'confidence'], 'reports/PROJECT_AUDIT.md section 7', { targets: ['moon'], operating: ['earth'] }),
    L('L_EARTH_CLIMATE', 'minor', 'evidence',
      'Earth climate is NASA POWER model/satellite-derived data for one grid cell and one year (2023), and the daily mean temperature T2M is absent (only T2M_MAX and T2M_MIN exist). It is not station data and does not vary per terrain cell.',
      'Earth thermal context is coarse and partly missing.', ['confidence'], 'reports/PROJECT_AUDIT.md section 7', { operating: ['earth'] }),
    L('L_NO_SOIL', 'major', 'evidence',
      'No surface composition, soil or regolith data are present. Traction, sinkage and slip cannot be assessed from terrain shape.',
      'Suitability, risk and route estimates ignore soil mechanics.', ['suitability', 'risk', 'confidence'], 'reports/intelligence_methodology.md (evidence gaps)', {}),
    L('L_VERTICAL_DATUMS', 'minor', 'data',
      'Each body has its own vertical datum. Elevation is used only inside one body (for grade and elevation gain), never compared across bodies.',
      'Absolute elevations are not comparable between Earth, Mars and the Moon.', ['similarity'], 'reports/PROJECT_AUDIT.md section 11', {}),
    L('L_COORDS_NOT_WGS84', 'major', 'data',
      'Mars and Moon lon/lat in the project files are body-native sphere coordinates, not WGS84. Do not place them on an Earth basemap.',
      'Use local metre coordinates (x_m_localTM, y_m_localTM) for any geometry on Mars or the Moon.', ['risk'], 'reports/PROJECT_AUDIT.md section 4', { operating: ['mars', 'moon'] }),
    L('L_UNRESOLVED_HAZARDS', 'critical', 'route',
      'Terrain metrics are statistics on 120 m (or 360 m) cells, and slope uses a 240 m baseline. Boulders, small craters, ditches and slopes steeper than the cell average are not resolved.',
      'A route that meets every limit can still cross hazards the data cannot see.', ['suitability', 'risk'], 'by construction of the processed grids (kernels_m in the summary JSON)', { levels: ['site', 'route', 'mission', 'domain'] }),
    L('L_HEURISTIC_INDICES', 'major', 'method',
      'Suitability and risk are transparent heuristic indices (0 to 100) built from the same DEM metrics, with expert-judgement weights. They are correlated by construction and are not calibrated probabilities.',
      'Compare them with each other only as rankings; do not read them as failure rates.', ['suitability', 'risk'], 'website/js/mission-model.js (SUITABILITY, RISK)', {}),
    L('L_UNKNOWN_BLOCKED', 'minor', 'method',
      'Cells with missing terrain metrics are treated as impassable. They are never assumed safe or interpolated.',
      'Routes and sites avoid data edges; this is conservative.', ['suitability', 'risk'], 'website/js/mission-engine.js', { levels: ['site', 'route', 'mission', 'domain'] }),
    L('L_PLACEHOLDER_ROVER', 'major', 'route',
      'Vehicle mass, speed, rolling resistance, drivetrain efficiency and base power are placeholder values unless supplied by the user. No real vehicle is modelled.',
      'Route time and energy are order-of-magnitude estimates only.', ['risk', 'confidence'], 'website/js/mission-model.js (SPECS.rover)', { needs: 'placeholder_rover' }),
    L('L_GENERIC_COST_MODEL', 'major', 'route',
      'Time and energy use a generic parametric model (speed derating with slope, rolling plus gravity work). There is no model of wheel slip, soil, thermal limits, power generation, communications or dust.',
      'Estimates are not calibrated to any vehicle and are not a flight-readiness assessment.', ['risk', 'confidence'], 'website/js/mission-engine.js (route cost model)', { needs: 'route' }),
    L('L_NO_ILLUM_COMMS', 'major', 'route',
      'Illumination, thermal, communication-window and solar-recharge constraints are not modelled. The energy budget is user-supplied and fixed.',
      'A plan can be feasible here and still be infeasible for lighting, thermal or communication reasons.', ['risk', 'confidence'], 'reports/intelligence_methodology.md (evidence gaps)', { needs: 'route' }),
    L('L_BUDGETS_USER', 'minor', 'route',
      'Time, energy and distance budgets exist only if the user supplies them. Unset budgets are reported as not evaluated.',
      'Feasibility flags are meaningful only for budgets the user set.', ['risk'], 'website/js/mission-model.js (SPECS.resources)', { needs: 'route' })
  ];

  // ------------------------------------------------------------------ output contract (documentation + shape check)
  var OUTPUT_CONTRACT = {
    note: 'Every assessment at every level (domain, site, route, strategy plan, mission) has these five SEPARATE sections. They are never merged into one number.',
    sections: {
      similarity: 'How close the terrain metrics are to the target reference (model output, reused from FieldZeroSimilarity). Unitless 0-100 typicality score, plus the per-feature explanation.',
      suitability: 'How well the terrain supports operating the configured vehicle (heuristic 0-100, higher better).',
      risk: 'Terrain hazard exposure (heuristic 0-100, higher worse) and, for routes, hazard-weighted route metrics.',
      confidence: 'Level (insufficient/low/medium/high) with numeric components, the limiting component and any ceiling applied. Confidence in the terrain-metric result, not in analog validity.',
      data_limitations: 'Array of limitation records that apply to this output, ordered by severity.'
    },
    every_value_has_a_basis: 'Objects carry a `basis` string naming one of BASIS (project_data, model_output, heuristic, estimate, assumption, placeholder, external_constant, user_input).',
    json_safe: 'Outputs contain only finite numbers, strings, booleans, null, arrays and plain objects. Missing values are null, never NaN, never 0.'
  };

  var SIMULATION_SCHEMA = {
    version: '1.0',
    note: 'Shape of FieldZeroMission.exportSimulationScenario(). Coordinates are local transverse-Mercator metres (x_m_localTM, y_m_localTM) of real grid-cell centres. The local origin differs per site and is not stored in the CSVs, so x/y are valid only within one site. Mars and Moon lon/lat are NOT WGS84.',
    top_level: ['schema_version', 'kind', 'label', 'body', 'scale_m', 'coordinate_frame', 'grid', 'vehicle', 'constraints', 'strategy', 'waypoints', 'path', 'profile', 'segments', 'expected', 'assumptions', 'data_limitations'],
    waypoint_fields: ['id', 'kind', 'row_index', 'x_m', 'y_m', 'lon_deg', 'lat_deg', 'elevation_m'],
    path_fields: 'Array of csv row indices, in travel order, each step to an 8-connected neighbour cell.',
    profile_fields: ['distance_m', 'elevation_m', 'cell_slope_deg', 'hazard'],
    segment_fields: ['from', 'to', 'horizontal_m', 'length_m', 'grade_deg', 'est_time_s', 'est_energy_wh']
  };

  // ------------------------------------------------------------------ small helpers
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function round(v, d) { if (!isNum(v)) return null; var f = Math.pow(10, d == null ? 2 : d); return Math.round(v * f) / f; }
  function clone(o) { return o === undefined ? undefined : JSON.parse(JSON.stringify(o)); }
  function issue(path, code, message) { return { path: path, code: code, message: message }; }

  // ------------------------------------------------------------------ location validation
  /**
   * A location is exactly one of { row_index } | { x_m, y_m } | { lon_deg, lat_deg }.
   * row_index is the 0-based row of the terrain CSV for the operating body and scale (the engine's stable id).
   * Returns { errors, location } where location is a normalised copy (or null if absent).
   */
  function validateLocation(loc, path) {
    var errors = [];
    if (loc === undefined || loc === null) return { errors: errors, location: null };
    if (!isObj(loc)) { errors.push(issue(path, 'TYPE', 'Location must be an object with row_index, or x_m and y_m, or lon_deg and lat_deg.')); return { errors: errors, location: null }; }
    var forms = [];
    if ('row_index' in loc) forms.push('row_index');
    if ('x_m' in loc || 'y_m' in loc) forms.push('xy');
    if ('lon_deg' in loc || 'lat_deg' in loc) forms.push('lonlat');
    if (forms.length !== 1) {
      errors.push(issue(path, forms.length ? 'CONFLICT' : 'REQUIRED', 'Give exactly one of row_index, (x_m, y_m) or (lon_deg, lat_deg).'));
      return { errors: errors, location: null };
    }
    var out = null;
    if (forms[0] === 'row_index') {
      if (!(typeof loc.row_index === 'number' && isFinite(loc.row_index) && Math.floor(loc.row_index) === loc.row_index && loc.row_index >= 0)) errors.push(issue(path + '.row_index', 'RANGE', 'row_index must be a non-negative integer.'));
      else out = { row_index: loc.row_index };
    } else if (forms[0] === 'xy') {
      if (!isNum(loc.x_m) || !isNum(loc.y_m)) errors.push(issue(path, 'TYPE', 'x_m and y_m must both be finite numbers (local transverse-Mercator metres).'));
      else out = { x_m: loc.x_m, y_m: loc.y_m };
    } else {
      if (!isNum(loc.lon_deg) || !isNum(loc.lat_deg)) errors.push(issue(path, 'TYPE', 'lon_deg and lat_deg must both be finite numbers.'));
      else if (loc.lat_deg < -90 || loc.lat_deg > 90) errors.push(issue(path + '.lat_deg', 'RANGE', 'lat_deg must be within -90..90.'));
      else if (loc.lon_deg < -360 || loc.lon_deg > 360) errors.push(issue(path + '.lon_deg', 'RANGE', 'lon_deg must be within -360..360.'));
      else out = { lon_deg: loc.lon_deg, lat_deg: loc.lat_deg };
    }
    return { errors: errors, location: out };
  }

  function validateKeepOut(list, path, errors, warnings) {
    var out = [];
    if (list === undefined || list === null) return out;
    if (!Array.isArray(list)) { errors.push(issue(path, 'TYPE', 'keepOut must be an array of zones.')); return out; }
    if (list.length > 200) errors.push(issue(path, 'RANGE', 'At most 200 keep-out zones.'));
    list.forEach(function (z, i) {
      var p = path + '[' + i + ']';
      if (!isObj(z)) { errors.push(issue(p, 'TYPE', 'Zone must be an object.')); return; }
      var hasXY = 'x_m' in z || 'y_m' in z, hasLL = 'lon_deg' in z || 'lat_deg' in z;
      if (hasXY === hasLL) { errors.push(issue(p, hasXY ? 'CONFLICT' : 'REQUIRED', 'Give either (x_m, y_m, radius_m) or (lon_deg, lat_deg, radius_m).')); return; }
      if (!isNum(z.radius_m) || !(z.radius_m > 0) || z.radius_m > 1e6) { errors.push(issue(p + '.radius_m', 'RANGE', 'radius_m must be a number in (0, 1e6].')); return; }
      if (hasXY) {
        if (!isNum(z.x_m) || !isNum(z.y_m)) { errors.push(issue(p, 'TYPE', 'x_m and y_m must be finite numbers.')); return; }
        out.push({ x_m: z.x_m, y_m: z.y_m, radius_m: z.radius_m });
      } else {
        if (!isNum(z.lon_deg) || !isNum(z.lat_deg) || z.lat_deg < -90 || z.lat_deg > 90) { errors.push(issue(p, 'RANGE', 'lon_deg/lat_deg must be finite, lat within -90..90.')); return; }
        out.push({ lon_deg: z.lon_deg, lat_deg: z.lat_deg, radius_m: z.radius_m });
      }
    });
    return out;
  }

  // ------------------------------------------------------------------ mission configuration
  var TOP_KEYS = ['schema_version', 'name', 'id', 'targetBody', 'operatingBody', 'routeScaleM', 'strategy', 'objectives', 'rover', 'resources', 'constraints', 'priorities', 'start', 'goal', 'stops', 'similarityConfig'];

  function readGroup(groupName, input, specs, normalized, errors, warnings, defaultsUsed) {
    var src = input === undefined || input === null ? {} : input;
    if (!isObj(src)) { errors.push(issue(groupName, 'TYPE', groupName + ' must be an object.')); src = {}; }
    var known = Object.keys(specs).concat(Object.keys((BOOL_SPECS[groupName]) || {}));
    if (groupName === 'constraints') known.push('keepOut');
    Object.keys(src).forEach(function (k) { if (known.indexOf(k) === -1) warnings.push(issue(groupName + '.' + k, 'UNKNOWN_KEY', 'Unknown key ignored.')); });
    var out = {}, supplied = [];
    Object.keys(specs).forEach(function (k) {
      var spec = specs[k], p = groupName + '.' + k, v = src[k];
      if (v === undefined) {
        out[k] = spec.def;
        defaultsUsed.push({ path: p, value: spec.def, unit: spec.unit, basis: spec.basis, description: spec.desc });
        return;
      }
      if (v === null) {
        if (spec.nullable) { out[k] = null; supplied.push(k); return; }
        errors.push(issue(p, 'TYPE', p + ' cannot be null.')); out[k] = spec.def; return;
      }
      if (!isNum(v)) { errors.push(issue(p, 'TYPE', p + ' must be a finite number.')); out[k] = spec.def; return; }
      if (spec.integer && Math.floor(v) !== v) { errors.push(issue(p, 'TYPE', p + ' must be an integer.')); out[k] = spec.def; return; }
      if (v < spec.min || v > spec.max) { errors.push(issue(p, 'RANGE', p + ' must be within ' + spec.min + '..' + spec.max + ' ' + spec.unit + ' (got ' + v + ').')); out[k] = spec.def; return; }
      if (spec.warnAbove != null && v > spec.warnAbove) warnings.push(issue(p, 'SUSPICIOUS', p + ' = ' + v + ' ' + spec.unit + ' is unusually high for a ground vehicle.'));
      out[k] = v; supplied.push(k);
    });
    var bools = BOOL_SPECS[groupName] || {};
    Object.keys(bools).forEach(function (k) {
      var v = src[k], p = groupName + '.' + k;
      if (v === undefined) { out[k] = bools[k].def; defaultsUsed.push({ path: p, value: bools[k].def, unit: null, basis: 'assumption', description: bools[k].desc }); }
      else if (typeof v !== 'boolean') { errors.push(issue(p, 'TYPE', p + ' must be true or false.')); out[k] = bools[k].def; }
      else out[k] = v;
    });
    normalized[groupName] = out;
    return supplied;
  }

  /**
   * Validate and normalise a mission configuration.
   * Returns {
   *   valid, errors[], warnings[],            // each { path, code, message }
   *   config,                                 // normalised copy with every default applied (null if input unusable)
   *   defaults_used[],                        // { path, value, unit, basis, description } for every default applied
   *   assumptions[],                          // the defaults that are assumption / placeholder / heuristic, as readable text
   *   uses_placeholder_rover,                 // true if any rover parameter is a placeholder default
   *   placeholder_rover_params[]
   * }
   * Never throws for bad input; never repairs a bad value silently (a bad value is an error and is replaced
   * by the default ONLY in the returned config, which must not be used while valid is false).
   */
  function validateMissionConfig(input) {
    var errors = [], warnings = [], defaultsUsed = [], n = {};
    if (input === undefined || input === null) input = {};
    if (!isObj(input)) {
      return { valid: false, errors: [issue('', 'TYPE', 'Mission configuration must be an object.')], warnings: [], config: null, defaults_used: [], assumptions: [], uses_placeholder_rover: false, placeholder_rover_params: [] };
    }
    Object.keys(input).forEach(function (k) { if (TOP_KEYS.indexOf(k) === -1) warnings.push(issue(k, 'UNKNOWN_KEY', 'Unknown key ignored.')); });

    n.schema_version = SCHEMA_VERSION;
    if (input.name !== undefined && typeof input.name !== 'string') errors.push(issue('name', 'TYPE', 'name must be a string.'));
    n.name = typeof input.name === 'string' ? input.name.slice(0, 120) : 'FIELD//ZERO mission';
    if (input.id !== undefined && (typeof input.id !== 'string' || !/^[A-Za-z0-9_.\-]{1,64}$/.test(input.id))) errors.push(issue('id', 'TYPE', 'id must be 1-64 characters from A-Z a-z 0-9 _ . -'));
    n.id = typeof input.id === 'string' && /^[A-Za-z0-9_.\-]{1,64}$/.test(input.id) ? input.id : null;

    // bodies
    var tb = input.targetBody === undefined ? 'mars' : input.targetBody;
    if (input.targetBody === undefined) defaultsUsed.push({ path: 'targetBody', value: 'mars', unit: null, basis: 'assumption', description: 'Analog target body.' });
    if (TARGET_BODIES.indexOf(tb) === -1) { errors.push(issue('targetBody', 'ENUM', 'targetBody must be "mars" or "moon".')); tb = 'mars'; }
    n.targetBody = tb;
    var ob = input.operatingBody === undefined ? 'earth' : input.operatingBody;
    if (input.operatingBody === undefined) defaultsUsed.push({ path: 'operatingBody', value: 'earth', unit: null, basis: 'assumption', description: 'Body whose terrain the route is planned on (Earth = analog field campaign).' });
    if (ALL_BODIES.indexOf(ob) === -1) { errors.push(issue('operatingBody', 'ENUM', 'operatingBody must be "earth", "mars" or "moon".')); ob = 'earth'; }
    n.operatingBody = ob;
    if (ob !== 'earth' && ob !== tb) warnings.push(issue('operatingBody', 'CONFLICT', 'operatingBody (' + ob + ') differs from targetBody (' + tb + '); similarity is not applicable when operating off Earth.'));
    var rs = input.routeScaleM === undefined ? 120 : input.routeScaleM;
    if (input.routeScaleM === undefined) defaultsUsed.push({ path: 'routeScaleM', value: 120, unit: 'm', basis: 'assumption', description: 'Grid scale used for route planning (120 m primary, 360 m coarse).' });
    if (SCALES.indexOf(rs) === -1) { errors.push(issue('routeScaleM', 'ENUM', 'routeScaleM must be 120 or 360.')); rs = 120; }
    n.routeScaleM = rs;
    var st = input.strategy === undefined ? 'ALL' : input.strategy;
    if (input.strategy === undefined) defaultsUsed.push({ path: 'strategy', value: 'ALL', unit: null, basis: 'assumption', description: 'Plan all three strategies and compare them.' });
    if (st !== 'ALL' && STRATEGY_IDS.indexOf(st) === -1) { errors.push(issue('strategy', 'ENUM', 'strategy must be ALL, FAST, SAFE or SCIENTIFIC.')); st = 'ALL'; }
    n.strategy = st;

    // numeric groups
    readGroup('objectives', input.objectives, SPECS.objectives, n, errors, warnings, defaultsUsed);
    var roverSupplied = readGroup('rover', input.rover, SPECS.rover, n, errors, warnings, defaultsUsed);
    readGroup('resources', input.resources, SPECS.resources, n, errors, warnings, defaultsUsed);
    readGroup('constraints', input.constraints, SPECS.constraints, n, errors, warnings, defaultsUsed);
    n.constraints.keepOut = validateKeepOut(input.constraints && input.constraints.keepOut, 'constraints.keepOut', errors, warnings);

    // priorities (relative importance of the three strategy objectives; normalised to sum to 1)
    var pr = { speed: 1, safety: 1, science: 1 }, prSupplied = false;
    if (input.priorities !== undefined) {
      if (!isObj(input.priorities)) errors.push(issue('priorities', 'TYPE', 'priorities must be an object with speed, safety and science.'));
      else {
        Object.keys(input.priorities).forEach(function (k) { if (!(k in pr)) warnings.push(issue('priorities.' + k, 'UNKNOWN_KEY', 'Unknown key ignored.')); });
        ['speed', 'safety', 'science'].forEach(function (k) {
          var v = input.priorities[k];
          if (v === undefined) return;
          if (!isNum(v) || v < 0) errors.push(issue('priorities.' + k, 'RANGE', 'priorities.' + k + ' must be a number >= 0.'));
          else { pr[k] = v; prSupplied = true; }
        });
        if (prSupplied && pr.speed + pr.safety + pr.science <= 0) errors.push(issue('priorities', 'RANGE', 'At least one priority must be greater than 0.'));
      }
    }
    var ps = pr.speed + pr.safety + pr.science;
    n.priorities = ps > 0 ? { speed: pr.speed / ps, safety: pr.safety / ps, science: pr.science / ps } : { speed: 1 / 3, safety: 1 / 3, science: 1 / 3 };
    if (!prSupplied) defaultsUsed.push({ path: 'priorities', value: { speed: 1 / 3, safety: 1 / 3, science: 1 / 3 }, unit: null, basis: 'assumption', description: 'Equal weight on speed, safety and science when recommending a strategy.' });

    // locations
    var s = validateLocation(input.start, 'start'); errors = errors.concat(s.errors); n.start = s.location;
    var g = validateLocation(input.goal, 'goal'); errors = errors.concat(g.errors); n.goal = g.location;
    n.stops = [];
    if (input.stops !== undefined) {
      if (!Array.isArray(input.stops)) errors.push(issue('stops', 'TYPE', 'stops must be an array of locations.'));
      else {
        if (input.stops.length > 6) errors.push(issue('stops', 'RANGE', 'At most 6 stops.'));
        input.stops.forEach(function (loc, i) {
          var r = validateLocation(loc, 'stops[' + i + ']'); errors = errors.concat(r.errors);
          if (r.location) n.stops.push(r.location); else if (!r.errors.length) errors.push(issue('stops[' + i + ']', 'REQUIRED', 'Stop location is empty.'));
        });
      }
    }
    if (input.similarityConfig !== undefined && input.similarityConfig !== null && !isObj(input.similarityConfig)) errors.push(issue('similarityConfig', 'TYPE', 'similarityConfig must be an object (passed to FieldZeroSimilarity.resolveConfig).'));
    n.similarityConfig = isObj(input.similarityConfig) ? clone(input.similarityConfig) : null;

    // cross-field rules
    if (ob !== 'earth') {
      if (!n.start) errors.push(issue('start', 'REQUIRED', 'start is required when operatingBody is ' + ob + ': similarity-based site selection exists only for Earth, so no staging point can be proposed.'));
      if (!n.goal && !n.stops.length) errors.push(issue('goal', 'REQUIRED', 'goal or stops is required when operatingBody is ' + ob + '.'));
    }
    if (n.goal && n.stops.length) warnings.push(issue('goal', 'CONFLICT', 'Both goal and stops are given: goal is used by FAST and SAFE, stops by SCIENTIFIC.'));
    if (n.objectives.numScienceStops > n.objectives.numSites) warnings.push(issue('objectives.numScienceStops', 'CONFLICT', 'numScienceStops exceeds numSites; the tour is limited to the sites available.'));
    if (n.constraints.minSeparationM < n.routeScaleM) warnings.push(issue('constraints.minSeparationM', 'SUSPICIOUS', 'Separation below one grid cell lets adjacent cells be chosen as different sites.'));
    if (n.constraints.neighbourhoodRadiusM < 2 * n.routeScaleM) warnings.push(issue('constraints.neighbourhoodRadiusM', 'SUSPICIOUS', 'Neighbourhood radius is under two cells; suitability and risk context will be very local.'));

    var placeholders = Object.keys(SPECS.rover).filter(function (k) { return roverSupplied.indexOf(k) === -1 && SPECS.rover[k].basis === 'placeholder'; });
    var assumptions = defaultsUsed.filter(function (d) { return d.basis === 'assumption' || d.basis === 'placeholder' || d.basis === 'heuristic'; }).map(function (d) {
      return d.path + ' = ' + (isObj(d.value) ? JSON.stringify(d.value) : d.value) + (d.unit ? ' ' + d.unit : '') + ' [' + d.basis + ']: ' + d.description;
    });
    return {
      valid: errors.length === 0, errors: errors, warnings: warnings, config: n, defaults_used: defaultsUsed,
      assumptions: assumptions, uses_placeholder_rover: placeholders.length > 0, placeholder_rover_params: placeholders
    };
  }

  /** Validated config or throw an Error listing every problem. */
  function createMissionConfig(input) {
    var r = validateMissionConfig(input);
    if (!r.valid) {
      var e = new Error('Invalid mission configuration: ' + r.errors.map(function (x) { return x.path + ' (' + x.code + '): ' + x.message; }).join(' | '));
      e.name = 'MissionConfigError'; e.errors = r.errors; e.warnings = r.warnings; throw e;
    }
    return r;
  }

  // ------------------------------------------------------------------ terrain / analysis input validation
  /**
   * Check that terrain rows form a regular metre grid at scaleM and describe it.
   * Rows need x_m_localTM and y_m_localTM. Missing grid cells are allowed (they become unknown terrain);
   * duplicates and misaligned cells are not.
   * Returns { ok, nx, ny, x0, y0, scale_m, n_rows, n_cells, n_distinct, n_duplicates, n_misaligned, fill_fraction, issues[] }.
   */
  function analyzeGrid(rows, scaleM) {
    var res = { ok: false, nx: 0, ny: 0, x0: null, y0: null, scale_m: scaleM, n_rows: 0, n_cells: 0, n_distinct: 0, n_duplicates: 0, n_misaligned: 0, fill_fraction: 0, issues: [] };
    if (!Array.isArray(rows) || !rows.length) { res.issues.push(issue('rows', 'EMPTY', 'No terrain rows.')); return res; }
    if (SCALES.indexOf(scaleM) === -1) { res.issues.push(issue('scale', 'ENUM', 'scale must be 120 or 360.')); return res; }
    res.n_rows = rows.length;
    var i, minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity, bad = 0;
    for (i = 0; i < rows.length; i++) {
      var x = rows[i].x_m_localTM, y = rows[i].y_m_localTM;
      if (!isNum(x) || !isNum(y)) { bad++; continue; }
      if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
    }
    if (bad) { res.issues.push(issue('rows', 'BAD_COORD', bad + ' row(s) lack finite x_m_localTM / y_m_localTM.')); return res; }
    var nx = Math.round((maxx - minx) / scaleM) + 1, ny = Math.round((maxy - miny) / scaleM) + 1;
    if (nx * ny > 6e7) { res.issues.push(issue('rows', 'TOO_LARGE', 'Grid would exceed 6e7 cells.')); return res; }
    var seen = new Uint8Array(nx * ny), dup = 0, mis = 0, distinct = 0;
    for (i = 0; i < rows.length; i++) {
      var fx = (rows[i].x_m_localTM - minx) / scaleM, fy = (rows[i].y_m_localTM - miny) / scaleM, ix = Math.round(fx), iy = Math.round(fy);
      if (Math.abs(fx - ix) > 0.01 || Math.abs(fy - iy) > 0.01) { mis++; continue; }
      var k = ix + iy * nx;
      if (seen[k]) dup++; else { seen[k] = 1; distinct++; }
    }
    res.nx = nx; res.ny = ny; res.x0 = minx; res.y0 = miny; res.n_cells = nx * ny; res.n_distinct = distinct; res.n_duplicates = dup; res.n_misaligned = mis;
    res.fill_fraction = distinct / (nx * ny);
    if (mis) res.issues.push(issue('rows', 'MISALIGNED', mis + ' row(s) are not on a ' + scaleM + ' m lattice; this is not a regular grid at that scale.'));
    if (dup) res.issues.push(issue('rows', 'DUPLICATE', dup + ' row(s) share a grid cell with another row.'));
    if (res.fill_fraction < 0.5) res.issues.push(issue('rows', 'SPARSE', 'Fewer than half of the grid cells have rows (' + round(res.fill_fraction * 100, 1) + '%).'));
    res.ok = !mis && !dup && res.fill_fraction >= 0.5;
    return res;
  }

  /** Validate a terrain table (rows) for use by the planner. Returns { ok, errors[], warnings[], grid }. */
  function validateTerrainRows(rows, scaleM, body) {
    var errors = [], warnings = [], p = 'terrain.' + body + '.' + scaleM;
    if (ALL_BODIES.indexOf(body) === -1) errors.push(issue(p, 'ENUM', 'Unknown body "' + body + '".'));
    if (!Array.isArray(rows) || !rows.length) { errors.push(issue(p, 'EMPTY', 'No terrain rows for ' + body + ' at ' + scaleM + ' m.')); return { ok: false, errors: errors, warnings: warnings, grid: null }; }
    TERRAIN_COLUMNS.forEach(function (c) { if (!(c in rows[0])) errors.push(issue(p, 'MISSING_COLUMN', 'Rows lack column "' + c + '".')); });
    if (errors.length) return { ok: false, errors: errors, warnings: warnings, grid: null };
    var g = analyzeGrid(rows, scaleM);
    g.issues.forEach(function (x) { (g.ok ? warnings : errors).push(issue(p, x.code, x.message)); });
    if (g.ok && g.fill_fraction < 1) warnings.push(issue(p, 'HOLES', 'Grid has ' + (g.n_cells - g.n_distinct) + ' missing cell(s); they are treated as unknown terrain.'));
    return { ok: errors.length === 0, errors: errors, warnings: warnings, grid: g };
  }

  /** Check a FieldZeroSimilarity.analyze() result has what the planner needs. Returns { ok, errors[] }. */
  function checkAnalysisShape(analysis, nEarthRows120) {
    var errors = [];
    if (!analysis || !analysis.results) return { ok: false, errors: [issue('analysis', 'REQUIRED', 'No similarity analysis supplied.')] };
    TARGET_BODIES.forEach(function (t) {
      var r = analysis.results[t] && analysis.results[t][SITE_SCALE_M];
      if (!r || !Array.isArray(r.cells)) errors.push(issue('analysis.results.' + t, 'REQUIRED', 'Missing 120 m cells for ' + t + '.'));
      else if (nEarthRows120 != null && r.cells.length !== nEarthRows120) errors.push(issue('analysis.results.' + t, 'MISMATCH', 'Analysis has ' + r.cells.length + ' cells but the Earth 120 m terrain has ' + nEarthRows120 + ' rows. They must be the same table in the same order.'));
      if (!analysis.references || !analysis.references[t] || !analysis.references[t][SITE_SCALE_M]) errors.push(issue('analysis.references.' + t, 'REQUIRED', 'Missing reference for ' + t + '.'));
    });
    return { ok: errors.length === 0, errors: errors };
  }

  // ------------------------------------------------------------------ limitations selector
  var SEVERITY_ORDER = { critical: 0, major: 1, minor: 2 };
  /**
   * Static limitation records relevant to a context.
   * ctx: { target:'mars'|'moon'|null, operating:'earth'|'mars'|'moon', level:'domain'|'site'|'route'|'mission',
   *        hasRoute:boolean, placeholderRover:boolean }
   */
  function limitationsFor(ctx) {
    ctx = ctx || {};
    var level = ctx.level || 'mission', op = ctx.operating || 'earth';
    return DATA_LIMITATIONS.filter(function (l) {
      var a = l.applies || {};
      if (a.targets && (!ctx.target || a.targets.indexOf(ctx.target) === -1)) return false;
      if (a.operating && a.operating.indexOf(op) === -1) return false;
      if (a.levels && a.levels.indexOf(level) === -1) return false;
      if (a.needs === 'route' && !(ctx.hasRoute || level === 'route' || level === 'mission')) return false;
      if (a.needs === 'placeholder_rover' && !ctx.placeholderRover) return false;
      return true;
    }).sort(function (x, y) { return (SEVERITY_ORDER[x.severity] - SEVERITY_ORDER[y.severity]) || (x.id < y.id ? -1 : 1); }).map(function (l) {
      return { id: l.id, severity: l.severity, category: l.category, statement: l.statement, effect: l.effect, affects: l.affects.slice(), source: l.source, basis: 'project_data' };
    });
  }

  // ------------------------------------------------------------------ output checks
  /** Verify a value is JSON-safe (no NaN, Infinity, undefined, functions, typed arrays). Returns { ok, path }. */
  function checkJsonSafe(v, path, depth) {
    path = path || '$'; depth = depth || 0;
    if (depth > 60) return { ok: false, path: path + ' (too deep)' };
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return { ok: true };
    if (typeof v === 'number') return isFinite(v) ? { ok: true } : { ok: false, path: path + ' (' + v + ')' };
    if (Array.isArray(v)) { for (var i = 0; i < v.length; i++) { var r = checkJsonSafe(v[i], path + '[' + i + ']', depth + 1); if (!r.ok) return r; } return { ok: true }; }
    if (typeof v === 'object') {
      if (ArrayBuffer.isView && ArrayBuffer.isView(v)) return { ok: false, path: path + ' (typed array)' };
      var ks = Object.keys(v);
      for (var j = 0; j < ks.length; j++) { var q = checkJsonSafe(v[ks[j]], path + '.' + ks[j], depth + 1); if (!q.ok) return q; }
      return { ok: true };
    }
    return { ok: false, path: path + ' (' + typeof v + ')' };
  }

  /** Shape check for one assessment object: the five sections must exist and be separate. Returns { ok, errors[] }. */
  function validateAssessmentShape(a) {
    var errors = [];
    if (!isObj(a)) return { ok: false, errors: ['assessment is not an object'] };
    SECTION_KEYS.forEach(function (k) {
      if (!(k in a)) errors.push('missing section "' + k + '"');
      else if (k === 'data_limitations' ? !Array.isArray(a[k]) : !isObj(a[k])) errors.push('section "' + k + '" has the wrong type');
    });
    if (isObj(a.similarity) && isObj(a.risk) && a.similarity === a.risk) errors.push('similarity and risk must not be the same object');
    var j = checkJsonSafe(a);
    if (!j.ok) errors.push('not JSON-safe at ' + j.path);
    return { ok: errors.length === 0, errors: errors };
  }

  function classifyRisk(index) {
    if (!isNum(index)) return null;
    for (var i = 0; i < RISK.classes.length; i++) if (index < RISK.classes[i][0]) return RISK.classes[i][1];
    return 'severe';
  }
  function confidenceLevel(value) {
    if (!isNum(value)) return 'insufficient';
    var t = CONFIDENCE.thresholds;
    return value >= t.high ? 'high' : value >= t.medium ? 'medium' : value >= t.low ? 'low' : 'insufficient';
  }
  function minLevel(a, b) { var L2 = CONFIDENCE.levels; return L2[Math.min(L2.indexOf(a), L2.indexOf(b))]; }

  /** Effective (strategy-scaled) constraints for a strategy. Pure arithmetic on the user constraints. */
  function effectiveConstraints(constraints, strategy, scaleM) {
    var s = typeof strategy === 'string' ? (strategy === 'BASE' ? BASE_STRATEGY : STRATEGIES[strategy]) : strategy;
    if (!s) throw new Error('Unknown strategy "' + strategy + '".');
    var f = s.route.slopeLimitFactor;
    return {
      strategy: s.id, slope_limit_user_deg: constraints.maxSlopeDeg, slope_limit_applied_deg: constraints.maxSlopeDeg * f,
      roughness_limit_user_m: constraints.maxRoughnessM, roughness_limit_applied_m: constraints.maxRoughnessM == null ? null : constraints.maxRoughnessM * f,
      slope_limit_factor: f, hazard_buffer_m: s.route.hazardBufferM, hazard_buffer_cells: s.route.hazardBufferM > 0 ? Math.ceil(s.route.hazardBufferM / scaleM - 1e-9) : 0,
      keep_out_zones: constraints.keepOut.length, basis: 'assumption'
    };
  }

  return {
    version: VERSION, SCHEMA_VERSION: SCHEMA_VERSION, LABEL: LABEL,
    BASIS: BASIS, BODIES: BODIES, TARGET_BODIES: TARGET_BODIES, ALL_BODIES: ALL_BODIES, SCALES: SCALES, SITE_SCALE_M: SITE_SCALE_M,
    FEATURE_COLUMNS: FEATURE_COLUMNS, TERRAIN_COLUMNS: TERRAIN_COLUMNS, FEATURE_INFO: FEATURE_INFO,
    STRATEGY_IDS: STRATEGY_IDS, STRATEGIES: STRATEGIES, BASE_STRATEGY: BASE_STRATEGY, SECTION_KEYS: SECTION_KEYS,
    SPECS: SPECS, SUITABILITY: SUITABILITY, RISK: RISK, CONFIDENCE: CONFIDENCE,
    DATA_LIMITATIONS: DATA_LIMITATIONS, OUTPUT_CONTRACT: OUTPUT_CONTRACT, SIMULATION_SCHEMA: SIMULATION_SCHEMA,
    validateMissionConfig: validateMissionConfig, createMissionConfig: createMissionConfig, validateLocation: validateLocation,
    analyzeGrid: analyzeGrid, validateTerrainRows: validateTerrainRows, checkAnalysisShape: checkAnalysisShape,
    limitationsFor: limitationsFor, checkJsonSafe: checkJsonSafe, validateAssessmentShape: validateAssessmentShape,
    classifyRisk: classifyRisk, confidenceLevel: confidenceLevel, minLevel: minLevel, effectiveConstraints: effectiveConstraints,
    util: { round: round, isNum: isNum, isObj: isObj, clone: clone }
  };
});
