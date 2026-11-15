# MOON status
_Generated 2026-11-14T15:09:42+00:00 by 03_validate.py from files currently on disk._

**1 of 1 dataset(s) are on disk AND validated.**

## A. Code (does not imply any data exists)
- LOLA windowed read / full-file fallback: written; server range support UNTESTED
- 0.5 scale factor applied at processing (once): written; needs the selftest on your machine
- terrain processor at common metre scale: written; math unit-tested
- validator: written

## B. Scientific data (verified from files on disk)
### LRO LOLA global LDEM 118 m, Mar 2014 (USGS Astrogeology) - site `moon_taurus_littrow` - **VALIDATED**
- file `raw\moon\moon_taurus_littrow_lola_window.tif`, 52,271 bytes, sha256 `67c2c0d2ebd1e2e9f44caaf587ad62fc...`
- raster 196x170, int16, CRS projected=True, pixel [118.451, 118.451] m, valid pixels 33,320/33,320, elevation -2925.0..-205.5 m, site coverage 100.0 %
  - PASS: file size > 0 - 52271 bytes
  - PASS: size equals download log - log 52271 vs disk 52271
  - PASS: sha256 equals download log - file unchanged since download
  - PASS: TIFF header - b'II*\x00'
  - PASS: has CRS - PROJCS["SimpleCylindrical Moon",GEOGCS["GCS_Moon",DATUM["D_Moon",SPHEROID["Moon",1737400,0
  - PASS: raster has pixels - 196 x 170
  - PASS: geotransform valid - | 118.45, 0.00, 921545.57|
| 0.00,-118.45, 621865.58|
| 0.00, 0.00, 1.00|
  - PASS: pixel size matches expected resolution - measured 118.5 x 118.5 m, expected ~118.4 m
  - PASS: raster overlaps site bbox - 100.0 % of site bbox covered
  - PASS: valid pixels >= 90% - 33,320 of 33,320 valid (100.00 %)
  - PASS: elevations plausible for body (after scale) - -2925.0..-205.5 m, allowed -9500.0..11000.0
  - PASS: not a constant raster - std 656.752 m

## C. Processed products (must match a validated source file)
- `moon_taurus_littrow` @ 120 m: 29,535 valid cells, extent [21.48, 19.8] km, consistent with validated raw file: True
- `moon_taurus_littrow` @ 360 m: 3,416 valid cells, extent [21.96, 20.16] km, consistent with validated raw file: True

## D. Not implemented / not collected
- Diviner temperature / rock abundance - researched in DATASET_INVENTORY.md, no code
- Moon has no atmosphere: no pressure/wind dataset exists; solar flux not verified
