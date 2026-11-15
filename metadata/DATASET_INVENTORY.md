# FIELD//ZERO — Phase 1 Dataset Inventory (discovery & verification only; nothing downloaded)
Compiled 2026-11-14 from official catalog/documentation pages retrieved this session.

**Confidence tags** — ✔ confirmed on an official page retrieved this session · ◐ from a secondary/third-party source (package docs, papers) · ✖ not verified (my background knowledge or absent) · "—" not applicable.
**Link verification limit:** my sandbox cannot reach NASA/USGS hosts, so no URL was HTTP-tested. "URL ✔" means the URL is printed on the official catalog page as the file link. Run `scripts/verify_links.py` on your machine for real status codes.

---------------------------------------------------------------------
## A. ESSENTIAL (MVP)

### A1. NASA POWER Daily API — Earth (Western Desert)
| Field | Value |
|---|---|
| Name | NASA POWER (Prediction Of Worldwide Energy Resources) — Daily temporal API, point endpoint |
| Source / URL | NASA LaRC. `https://power.larc.nasa.gov/api/temporal/daily/point` (docs: https://power.larc.nasa.gov/docs/services/api/temporal/daily/) ✔ |
| Variables | T2M, T2M_MAX, T2M_MIN (air temp 2 m); ALLSKY_SFC_SW_DWN (solar); WS2M (wind 2 m); PS (surface pressure) — names ◐/✔ via official examples and third-party package docs |
| Spatial resolution | Native source grids: meteorology from MERRA-2, solar from CERES SYN1deg/GEWEX SRB/FLASHFlux ✔. Official page cites a 0.5°×0.5° global grid ✔; third-party says ~55 km ◐. One value per grid cell — no sub-cell detail |
| Coverage | Global ✔ (point query at your lat/lon) |
| Units | T2M °C ◐; PS kPa ◐; WS2M m/s ◐; ALLSKY_SFC_SW_DWN **depends on community** (kWh/m²/day for RE/SB, MJ/m²/day listed for AG ◐) — read the `parameters` block in each response |
| Format | JSON, CSV, ASCII, NetCDF ✔ (ICASA for AG only) |
| Period | Meteorology 1981-01-01 → near-real-time ✔; solar 1984 → near-real-time (GEWEX SRB 1984–2000, CERES SYN1deg 2001→, FLASHFlux for latest) ✔ |
| Auth | None required ◐ (third-party states no key; official examples contain none) |
| Python download | Yes — `requests`, ~1 call per site |
| **Caveat** | Community matters: official example fetches `PS` with `community=AG`; a third-party script lists PS and WS2M under AG. **My earlier script used `community=RE` and may fail or return other units — must change to AG.** Confirm with the parameter-list endpoint (`/api/system/manager/parameters?community=ag&temporal=daily`, pattern ◐). Modelled/reanalysis data, not station measurements. |

### A2. NASADEM_HGT v001 — Earth elevation
| Field | Value |
|---|---|
| Name | NASADEM Merged DEM Global 1 arc second V001 (NASADEM_HGT) |
| Source / URL | NASA LP DAAC. DOI 10.5067/MEASURES/NASADEM/NASADEM_HGT.001 ✔; CMR concept C2763264768-LPCLOUD ✔; catalog https://www.earthdata.nasa.gov/data/catalog/lpcloud-nasadem-hgt-001 ✔ |
| Variables | Elevation; number-of-scenes layer (NUM); water mask ✔ |
| Resolution | 1 arc-second (~30 m) ✔ |
| Coverage | 60°N–56°S, 1°×1° tiles, named by lower-left corner ✔. Your Western Desert bbox falls in tile **n27e028** (derived from the naming rule) |
| Units | Metres (orthometric height) ◐ |
| Format | HGT per tile, distributed zipped; NetCDF4 variant exists as NASADEM_NC ✔ |
| Period | Derived from the SRTM mission (Feb 2000) ✖ not re-verified |
| Auth | **Earthdata Login required** ✔ (package docs: `.netrc`, env vars or interactive login) |
| Python download | Yes, with credentials — `earthaccess` library (CMR search + authenticated download) |
| Caveat | Free account needed (urs.earthdata.nasa.gov). I cannot create it or hold your password. |

### A3. Mars 2020 Science Investigation CTX DEM Mosaic — Jezero (replaces my earlier global-MOLA guess)
| Field | Value |
|---|---|
| Name | Mars 2020 Science Investigation CTX DEM Mosaic (file `M20_JezeroCrater_CTXDEM_20m.tif`) |
| Source / URL | USGS Astrogeology (author F. Calef; PDS-derived), published 2021-10-14 ✔. File: `https://planetarymaps.usgs.gov/mosaic/mars2020_trn/CTX/ScienceInvestigationMaps_JPL/M20_JezeroCrater_CTXDEM_20m.tif` ✔ (page: https://astrogeology.usgs.gov/search/map/mars_2020_science_investigation_ctx_dem_mosaic) |
| Variables | Elevation ✔ |
| Resolution | 20 m/pixel ✔ |
| Coverage | Entire Jezero crater ✔ (exact bounds not stated in retrieved text — read from GeoTIFF after download) |
| Units | Metres; vertically localized to MOLA ✔ |
| Format | GeoTIFF ✔, **87 MB** ✔ |
| Period | Derived from MRO CTX stereo images (acquisition dates not retrieved) ✖ |
| Auth | None ✔ (public) |
| Python download | Yes — plain HTTP GET (small) |
| Caveat | CRS not stated in retrieved text; likely projected (metres), so my processor's lon/lat-degree assumption must be fixed. DEMs were produced with Ames Stereo Pipeline ✔ |

### A4. LRO LOLA Global DEM 118 m — Moon elevation
| Field | Value |
|---|---|
| Name | Moon LRO LOLA DEM 118m (`Lunar_LRO_LOLA_Global_LDEM_118m_Mar2014.tif`) |
| Source / URL | USGS Astrogeology / LOLA Science Team (GSFC), 2014-03-11 ✔. File: `https://planetarymaps.usgs.gov/mosaic/Lunar_LRO_LOLA_Global_LDEM_118m_Mar2014.tif` ✔ (page: https://astrogeology.usgs.gov/search/map/moon_lro_lola_dem_118m) |
| Variables | Elevation |
| Resolution | 256 pixels/degree ≈ 118 m/px ✔ |
| Coverage | Global (≈ ±90°) ✔ |
| Units | Metres, **but stored as int16 with scaler 0.5 → divide pixel values by 2** ✔. Datum: lunar reference sphere, radius 1737.4 km (stated for a related USGS product; confirm in label) ◐ |
| Format | GeoTIFF ✔, **8 GB** ✔ |
| Period | LOLA data through the Mar-2014 product ✔ (name) |
| Auth | None ✔ (public domain) |
| Python download | Yes, but 8 GB. Preferred: windowed read (HTTP range requests via rasterio/GDAL) of only the bbox — **server range-request support is untested** ✖. Fallback: full download, or PDS GDR tiles. |
| Caveat | **My earlier processor ignores the 0.5 scale factor — values would be 2× too large. Must fix.** |

### A5. Mars 2020 MEDA — Mars atmosphere / temperature / wind / solar flux at Jezero
| Field | Value |
|---|---|
| Name | Mars 2020 Mars Environmental Dynamics Analyzer (MEDA) bundle, collections `data_derived_env` (recommended) and `data_calibrated_env` |
| Source / URL | PDS Atmospheres Node. PDS4 bundle `urn:nasa:pds:mars2020_meda`, DOI 10.17189/1522849 ✔. Release readme: `https://pds.nasa.gov/data/pds4/releases/atmos/mars2020_meda-20260811/readme.txt` ✔ (instrument page: https://atmos.nmsu.edu/data_and_services/atmospheres_data/PERSEVERANCE/meda.html ✔). **Per-file directory layout not verified** ✖ |
| Variables | Pressure; air temperature (ATS); ground/sky/IR temps (TIRS); downward solar radiation (7 bands + panchromatic) and diffuse radiation (RDS); relative humidity; horizontal/vertical wind speed and direction ✔ |
| Resolution | In-situ point (Perseverance rover, Jezero); 1 Hz sampling; baseline ~12 h per sol, even hours on even sols / odd hours on odd sols ✔ |
| Coverage | Jezero crater along rover traverse; landing 2021 → ongoing (≥ sol 1450 as of 2025 ◐) |
| Units | Pressure "mbar", temperature K, solar W/m², wind m/s, humidity %RH — as listed by PDS ✔ (**confirm in XML labels**; wording of pressure unit looks unusual) |
| Format | CSV (one file per sensor per sol) + XML label ✔ |
| Auth | None (public PDS) ◐ |
| Python download | Yes in principle (HTTP), but needs a file-listing/index step (PDS provides CSV indices ◐). Thousands of sol-files → MVP must pull a **sampled set of sols** |
| Caveat | Wind data before sol 36 and humidity before sol 63 are unreliable ✔; derived pressure uses barocap 3, check barocap 2 if discontinuities ✔; use highest file version only ✔; invalid fill value 9999999999 ✔ |

### A6. LRO Diviner derived gridded products — Moon temperature (and rock abundance)
| Field | Value |
|---|---|
| Name | LRO Diviner Lunar Radiometer derived products: GDR Level 2 (brightness/bolometric temperature), GDR Level 3 (rock abundance, soil temperature), Global High-Resolution Mosaics (GHRM) |
| Source / URL | PDS Geosciences Node. PDS4 bundle `urn:nasa:pds:lro_diviner_derived1`, DOI 10.17189/wj0s-w188 ✔ (docs: https://ode.rsl.wustl.edu/moon/pagehelp/Content/Missions_Instruments/LRO/DIVINER/GDR_L2.htm ✔). **Direct file URLs not verified** ✖ |
| Variables | L2: visual brightness, brightness temps for IR channels, bolometric temp, local time, Julian date; day/night split ✔. L3: rock abundance, soil temperature, Christiansen-feature position, RMS fit error ✔. GHRM: nighttime brightness/bolometric/regolith temperature and rock abundance ◐ |
| Resolution | L2 cylindrical at 128, 64, 16, 4, 1 ppd ✔ (128 ppd ≈ 237 m at equator, my arithmetic); L3 32 ppd, ±60° ✔; GHRM 128 ppd, 70°S–70°N ✔ |
| Coverage | Near-global ✔ — Taurus-Littrow (≈20°N) is inside all of them |
| Units | Kelvin (L2 valid range 10–450 K ✔); rock abundance as a fraction ◐ |
| Format | IMG (16-bit LSB, detached .LBL) and JPEG2000 ✔; GHRM also GeoTIFF ✔ |
| Period | 2009 → (GHRM uses ~13 years of data ◐; L2 binned per 27-day mapping cycle ✔) |
| Auth | None (public PDS) ◐ |
| Python download | Probably yes (HTTP via PDS/ODE) once exact URLs are confirmed ✖ |
| Caveat | Nighttime surface/near-surface temperature products; bolometric temperatures probe roughly the top 30 cm ◐. These are *measured/derived thermal maps*, not air temperature (Moon has no atmosphere). |

---------------------------------------------------------------------
## B. OPTIONAL (future improvements)

| # | Dataset | Source / URL | Res. | Coverage | Format | Auth | Python | Notes |
|---|---|---|---|---|---|---|---|---|
| B1 | Mars MGS MOLA – MEX HRSC Blended DEM Global 200 m v2 | USGS; `https://planetarymaps.usgs.gov/mosaic/Mars/HRSC_MOLA_Blend/Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif` ✔ | 200 m ✔ | Global ✔ | GeoTIFF, **11 GB** ✔ | None | Yes (window read, range support ✖) | MOLA (CC0) + HRSC (CC BY-SA 3.0 IGO) ✔ — attribution needed. Use for regional context beyond Jezero. |
| B2 | Mars MOLA interpolated DEM 463 m (128 ppd) | Listed as global GeoTIFF on USGS foundational-data table ✔ | 463 m ✔ | Global | GeoTIFF/IMG | None | ✖ | **Direct URL not verified. The URL in my earlier `config.py` was a guess — do not use.** |
| B3 | Mars Sample Return TRN HiRISE DTM & Orthoimage mosaics | USGS (2025-02-28); `https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Mars/MSR_TRN_HiRISE_soc_003_USGS_release_aug2024/MSR_TRN_HiRISE_soc_003_USGS_release_aug2024_mosaics.zip` ✔ | not retrieved ✖ | Jezero region | GeoTIFF in zip, **5.3 GB** ✔ | None | Yes | Highest-detail terrain for roughness at rover scale. |
| B4 | Mars 2020 TRN HiRISE DTM mosaic (2020) | USGS (DOI 10.5066/P9QJDP48 is the *ortho* product; DTM record at usgs.gov/data/mars-2020-terrain-relative-navigation-hirise-dtm-mosaic ✔) | not retrieved ✖ | bbox 77.2229, 18.3068 → 77.584, 18.6693 ✔ (ortho product) | GeoTIFF | None | ✖ | Superseded in part by B3. |
| B5 | MADNet HiRISE DTM mosaic Jezero 50 cm | Tao et al. 2023, DOI 10.17169/refubium-38359 ✔ | 0.5 m ✔ | Jezero landing site | — | ✖ | ✖ | **Not NASA** (FU Berlin/UCL); ML-refined product. |
| B6 | MEDA derived air temperature (Munguira et al.) | Zenodo DOI 10.5281/zenodo.7461835 ✔ | — | Jezero, first 400–700 sols ✔ | zip, 289 MB ✔ | None | Yes | Research-derived convenience set; good smoke test for the temperature pipeline. |
| B7 | SLDEM2015 (LOLA + SELENE TC merged DEM) | USGS foundational table ✔; direct URL ✖ | ~60 m (512 ppd) ✔ | 60°S–60°N ✔ | GeoTIFF/IMG/JP2 ✔ | None | ✖ | Better lunar resolution at Taurus-Littrow than A4. |
| B8 | LROC WAC GLD100 DTM | ASU/USGS ✔ | 100 m (118 m grid) ✔ | 79°S–79°N ✔ | GeoTIFF/ISIS ✔ | None | ✖ | Stereo-derived cross-check of LOLA. |
| B9 | LMMP LRO-NAC DEMs | USGS foundational table ✔ | 1.5 m ✔ | Regional (e.g. Apollo sites) ✔ | GeoTIFF | None | ✖ | Only if a NAC DEM covers your chosen box. |
| B10 | Copernicus DEM GLO-30 (Earth fallback) | ESA/Sinergise; AWS bucket `s3://copernicus-dem-30m/`, no AWS account needed ✔ | 30 m ✔ | Global (some tiles withheld) ✔ | Cloud-Optimised GeoTIFF ✔ | None ✔ | Yes | **Not NASA**; a DSM (includes surface objects) ✔. Use only if you decline the Earthdata account. |
| B11 | POWER climatology / hourly | same API (`/temporal/climatology/point`, `/temporal/hourly/point`) ✔ | as A1 | Global | JSON/CSV/NetCDF | None | Yes | Hourly gives diurnal cycle, closer in kind to MEDA/Diviner local-time products. |
| B12 | Surface-characteristic layers (Earth land cover/soil; Mars THEMIS/TES thermal inertia & albedo) | **Not researched this session** ✖ | — | — | — | — | — | Candidates only; no claims made. |

---------------------------------------------------------------------
## Measured-variable coverage matrix (MVP sets only)
| Feature | Earth | Mars | Moon |
|---|---|---|---|
| Elevation → slope, roughness, variability | NASADEM 30 m | CTX DEM 20 m | LOLA 118 m |
| Temperature | POWER (modelled air) | MEDA (in-situ air/ground) | Diviner (orbital surface) |
| Pressure | POWER PS | MEDA | **None — no atmosphere (≈ vacuum)** |
| Wind | POWER WS2M | MEDA | **None — no atmosphere** |
| Solar radiation | POWER (satellite-derived) | MEDA RDS | **No dataset verified** (would be a computed illumination model, not a measurement) |
| Surface characteristics | not researched | not researched | Diviner rock abundance |

## Corrections to my earlier (pre-verification) pipeline
1. POWER community `RE` → `AG`; confirm parameter list. 
2. Remove guessed MOLA 463 m URL; use A3 (CTX 20 m) for Jezero.
3. LOLA int16 scale factor 0.5 must be applied.
4. CTX DEM is likely in a projected CRS → processor must read pixel size in metres instead of assuming degrees.
5. Replace hand-written CMR/netrc code with `earthaccess`.
6. Resolutions differ (20 m / 30 m / 118 m): slope and roughness depend on baseline, so compare after resampling all three to a common scale (e.g. 120 m, plus a second scale).
