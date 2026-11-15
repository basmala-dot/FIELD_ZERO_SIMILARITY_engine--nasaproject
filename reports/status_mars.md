# MARS status
_Generated 2026-11-14T15:09:40+00:00 by 03_validate.py from files currently on disk._

**1 of 1 dataset(s) are on disk AND validated.**

## A. Code (does not imply any data exists)
- CTX DEM downloader (resumable, size-vs-server check): written; not yet run against USGS
- projected-CRS handling (pyproj + local metre grid): written; needs the selftest on your machine
- terrain processor at common metre scale: written; math unit-tested
- validator: written

## B. Scientific data (verified from files on disk)
### Mars 2020 Science Investigation CTX DEM Mosaic 20 m (USGS Astrogeology) - site `mars_jezero` - **VALIDATED**
- file `raw\mars\M20_JezeroCrater_CTXDEM_20m.tif`, 90,345,300 bytes, sha256 `ba7f706ea1b5d63a562f28a7dcf7a7f3...`
- raster 4456x5067, float32, CRS projected=True, pixel [20.0, 20.0] m, valid pixels 22,564,575/22,578,552, elevation -3504.645263671875..-475.8408203125 m, site coverage 100.0 %
  - PASS: file size > 0 - 90345300 bytes
  - PASS: size equals download log - log 90345300 vs disk 90345300
  - PASS: sha256 equals download log - file unchanged since download
  - PASS: size equals server Content-Length - server 90345300 vs disk 90345300
  - PASS: size in expected range - 90.3 MB, expected 70-105 MB
  - PASS: TIFF header - b'II*\x00'
  - PASS: has CRS - PROJCS["Jezero_Crater_Projection",GEOGCS["GCS_Mars_2000_Sphere",DATUM["Mars_2000_(Sphere)"
  - PASS: raster has pixels - 4456 x 5067
  - PASS: geotransform valid - | 20.00, 0.00, 4329000.00|
| 0.00,-20.00, 1143420.00|
| 0.00, 0.00, 1.00|
  - PASS: pixel size matches expected resolution - measured 20.0 x 20.0 m, expected ~20.0 m
  - PASS: raster overlaps site bbox - 100.0 % of site bbox covered
  - PASS: valid pixels >= 90% - 22,564,575 of 22,578,552 valid (99.94 %)
  - PASS: elevations plausible for body (after scale) - -3504.6..-475.8 m, allowed -9000.0..22000.0
  - PASS: not a constant raster - std 403.930 m

## C. Processed products (must match a validated source file)
- `mars_jezero` @ 120 m: 96,369 valid cells, extent [42.36, 32.76] km, consistent with validated raw file: True
- `mars_jezero` @ 360 m: 10,856 valid cells, extent [42.48, 33.12] km, consistent with validated raw file: True

## D. Not implemented / not collected
- MEDA atmosphere (pressure, temperature, wind, solar) - researched in DATASET_INVENTORY.md, no code
- Mars surface characteristics (thermal inertia/albedo)
