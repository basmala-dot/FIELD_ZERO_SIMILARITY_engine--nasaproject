# EARTH status
_Generated 2026-11-14T15:09:40+00:00 by 03_validate.py from files currently on disk._

**1 of 2 dataset(s) are on disk AND validated.**

## A. Code (does not imply any data exists)
- config / sites / scales: written
- NASA POWER downloader (community chosen per variable by trial): written; not yet run against the real API
- NASADEM: earthaccess download, zip extract, HGT->GeoTIFF, mosaic: written; HGT reader unit-tested on a synthetic tile; rasterio steps need the selftest on your machine
- terrain processor at common metre scale: written; math unit-tested on analytic surfaces
- validator: written

## B. Scientific data (verified from files on disk)
### NASADEM_HGT v001 (NASA LP DAAC) - site `earth_western_desert` - **VALIDATED**
- file `raw\earth\earth_western_desert_nasadem_window.tif`, 895,846 bytes, sha256 `c5a50a52c8d02a9721c8ba6ca7e9317d...`
- raster 1080x1080, int16, CRS projected=False, pixel [27.478, 30.922] m, valid pixels 1,166,400/1,166,400, elevation -33.0..293.0 m, site coverage 100.0 %
  - PASS: file size > 0 - 895846 bytes
  - PASS: size equals download log - log 895846 vs disk 895846
  - PASS: sha256 equals download log - file unchanged since download
  - PASS: TIFF header - b'II*\x00'
  - PASS: has CRS - EPSG:4326
  - PASS: raster has pixels - 1080 x 1080
  - PASS: geotransform valid - | 0.00, 0.00, 28.00|
| 0.00,-0.00, 27.45|
| 0.00, 0.00, 1.00|
  - PASS: pixel size matches expected resolution - measured 27.5 x 30.9 m, expected ~30.0 m
  - PASS: raster overlaps site bbox - 100.0 % of site bbox covered
  - PASS: valid pixels >= 90% - 1,166,400 of 1,166,400 valid (100.00 %)
  - PASS: elevations plausible for body (after scale) - -33.0..293.0 m, allowed -500.0..9000.0
  - PASS: not a constant raster - std 38.147 m
### NASA POWER daily point - site `earth_western_desert` - **PARTIAL**
- T2M: **FAILED** (community AG, units None, None/None valid days, sha256 f82cf7f68b0a24fb...)
  - FAIL: JSON parses with properties.parameter.T2M - KeyError('T2M')
  - PASS: sha256 equals download log - 
- T2M_MAX: **VALIDATED** (community AG, units C, 365/365 valid days, sha256 b7a8e29b78b2736b...)
- T2M_MIN: **VALIDATED** (community AG, units C, 365/365 valid days, sha256 f82cf7f68b0a24fb...)
- ALLSKY_SFC_SW_DWN: **VALIDATED** (community AG, units MJ/m^2/day, 365/365 valid days, sha256 8599953cff1e7b69...)
- WS2M: **VALIDATED** (community AG, units m/s, 365/365 valid days, sha256 dd9813557b0fd391...)
- PS: **VALIDATED** (community AG, units kPa, 365/365 valid days, sha256 5dd4595af9947d3f...)

## C. Processed products (must match a validated source file)
- `earth_western_desert` @ 120 m: 68,944 valid cells, extent [29.76, 33.36] km, consistent with validated raw file: True
- `earth_western_desert` @ 360 m: 7,896 valid cells, extent [30.24, 33.84] km, consistent with validated raw file: True

## D. Not implemented / not collected
- Surface-characteristic layers (land cover/soil)
- POWER hourly/climatology
