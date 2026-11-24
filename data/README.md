# Ghana restaurant catalogue — 24 November 2026

`ghana-restaurants-2026-11-24.json` is the production import payload built from the supplied
`Ghana-Restaurant-Master-A-Z.xlsx` workbook and `Ghana-Restaurant-Photos-4K.zip` archive.

- 940 source rows; 909 unique listings after removing same-name/same-city duplicates.
- 76 destinations across 10 regions.
- 571 primary photos uploaded to Cloudinary under `restaurants/ghana/`.
- 908 listings have coordinates; one listing had no geocodable address.
- Tripadvisor ratings and review counts are stored only as attributed `TRIPADVISOR` external
  aggregates. They are never written into the Travio rating fields.
- No review text is imported. The workbook contains no review copy.

Import with the maintained importer:

```bash
node --env-file=.env scripts/import-restaurant-venues.js \
  --file data/ghana-restaurants-2026-11-24.json \
  --brand ghana
```

The import is idempotent by slug. Re-running it updates the same venues, listings and external
aggregates.
