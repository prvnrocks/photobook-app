# Test fixtures

Tiny JPEGs (32x24 px, ~1 KB each) for `tests/image-exif.test.ts`. All metadata is **fake**:
no real photo, person or location is involved.

| File | Contents |
| --- | --- |
| `exif-gps.jpg` | EXIF DateTimeOriginal/CreateDate `2026:10:12 18:22:31`, OffsetTimeOriginal `+04:00`, GPS 24.47 N 54.33 E (fake point on the Abu Dhabi Corniche), Make `FakeCam`, Model `FakeCam Test 1`, Orientation 6 |
| `exif-no-offset-zero-gps.jpg` | DateTimeOriginal `2025:01:05 09:30:00` with no offset, GPS 0,0 (must be treated as missing), Make `FakeCam`, Model `Other`, Orientation 1 |
| `no-exif.jpg` | Same pixels, no APP1/EXIF segment |

## How they were made

`node tests/fixtures/make-image-fixtures.mjs` (macOS only — uses the built-in `sips`):
a gradient PNG is written in pure Node, converted to JPEG with `sips`, any APP1 segment is
stripped, and a hand-built little-endian TIFF/EXIF APP1 (IFD0 + Exif IFD + GPS IFD) is
spliced in after SOI/APP0. No third-party tools.

Synthetic images for dHash / blur tests are generated in code (`tests/helpers/synthetic-images.ts`).

## Photo fixtures for browser checks of `processPhoto`

`node tests/fixtures/make-photo-fixtures.mjs` (macOS, `sips`; run after the script above):

| File | Contents |
| --- | --- |
| `photo-orient6.jpg` | 400x300 stored pixels (red band on the stored top edge), EXIF copied from `exif-gps.jpg` (Orientation 6, fake date/GPS) → displays 300x400, ~13 KB |
| `photo-orient6.heic` | `sips -s format heic` of the above; has EXIF Orientation 6 **and** an `irot` box (like iPhone files), ~10 KB |
| `screenshot.png` | 390x844 flat UI-like PNG, no EXIF, ~7 KB |
