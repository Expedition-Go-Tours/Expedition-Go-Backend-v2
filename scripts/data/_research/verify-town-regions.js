#!/usr/bin/env node
/**
 * Verify the region stored on each City/Town row — and only report a town when
 * the evidence is unambiguous.
 *
 * The naive sweep (sweep-town-regions.js) asked the geocoder "where is <town>?"
 * and compared the top answer to the stored region. That produces mostly false
 * positives, because most flagged names are genuinely ambiguous: there really is
 * an Akropong in Ashanti AND one in Eastern, an Anyinam in Ashanti AND one in
 * Eastern, a Bantama in Kumasi AND one in Bono East. The geocoder just ranks one
 * first, so "the geocoder disagrees" is a coin flip, not an error.
 *
 * This script asks the two questions that actually settle it:
 *
 *   1. Does "<town>, <stored region>, Ghana" resolve to a settlement whose
 *      canonical region IS the stored region? If so the row is fine — the town
 *      really does exist there — and it is dropped (no false positive).
 *   2. Otherwise, does "<town>, Ghana" resolve to a settlement at all? If yes,
 *      and its canonical region differs from the stored one, the stored region
 *      is very likely wrong (this is what caught Bantama stored as Bono when it
 *      is a Kumasi suburb in Ashanti). That is a `mismatch`.
 *
 * Anything else — no in-country settlement, an overseas-only name (Bodi,
 * Kassana), a retired region name — is left alone as `unknown`. Never a guess.
 *
 * Writes scripts/data/_research/town-region-verify.json.
 *
 * Usage: node scripts/data/_research/verify-town-regions.js [--delayMs=250] [--limit=50]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const prisma = require('../../../utils/prismaClient');
const locationService = require('../../../utils/locationService');
const { canonicalRegion } = require('../../../utils/placeResolver');

const OUT = path.resolve(__dirname, 'town-region-verify.json');
const numArg = (name, fallback) => {
  const a = process.argv.find((v) => v.startsWith(`--${name}=`));
  return a ? parseInt(a.split('=')[1], 10) : fallback;
};
const DELAY = numArg('delayMs', 250);
const LIMIT = numArg('limit', 0);

/** Same rule as placeResolver.isSettlement: believe a category when present. */
function isSettlement(hit) {
  const cat = String(hit.category || '').toLowerCase();
  if (cat) {
    return /administrative|populated_place|locality|city|town|village|suburb|neighbourhood|neighborhood|district|municipal|region/.test(cat);
  }
  return !hit.street && !hit.housenumber;
}

const inGhana = (h) => String(h.countryCode || '').toLowerCase() === 'gh' || /ghana/i.test(h.country || '');

const fold = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
const head = (h) => String(h.formatted || '').split(',')[0].trim();

/**
 * The hit's own name must be the town we asked for. Without this the geocoder's
 * fuzzy results invent errors: "Abochia" matches "Abouhia, Kumasi" and "Adjoa"
 * matches "Adjoafua", neither of which is the town in question.
 */
const nameMatches = (h, name) => fold(head(h)) === fold(name);

/** Settlements inside Ghana that ARE this town, in provider order. */
async function settlements(query, name) {
  const hits = await locationService.search(query, 8).catch(() => []);
  return (hits || []).filter(
    (h) =>
      inGhana(h) &&
      h.latitude != null &&
      h.longitude != null &&
      isSettlement(h) &&
      (!name || nameMatches(h, name)),
  );
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

(async () => {
  let rows = await prisma.attraction.findMany({
    where: { status: 'ACTIVE', category: 'City / Town' },
    select: { name: true, region: true },
    orderBy: { name: 'asc' },
  });
  if (LIMIT) rows = rows.slice(0, LIMIT);

  const mismatches = [];
  const unknown = [];
  let confirmed = 0;
  let checked = 0;

  for (const r of rows) {
    const stored = canonicalRegion(r.region);
    try {
      // 1. Does the town exist in the region we stored?
      const inStored = await settlements(`${r.name}, ${r.region}, Ghana`, r.name);
      const foundInStored = stored && inStored.some((h) => canonicalRegion(h.region) === stored);

      if (foundInStored) {
        confirmed++;
      } else {
        // 2. Where does it actually resolve, and does that contradict us?
        await sleep(DELAY);
        const anywhere = await settlements(`${r.name}, Ghana`, r.name);
        const best = anywhere.find((h) => canonicalRegion(h.region));
        if (best) {
          const region = canonicalRegion(best.region);
          if (region && stored && region !== stored) {
            mismatches.push({
              name: r.name,
              stored: r.region,
              suggested: region,
              hit: best.formatted,
            });
          } else {
            confirmed++;
          }
        } else {
          unknown.push(r.name);
        }
      }
    } catch (e) {
      unknown.push(r.name);
      console.error(`ERR ${r.name}: ${e.message}`);
    }

    checked++;
    if (checked % 25 === 0) {
      fs.writeFileSync(OUT, JSON.stringify({ done: false, checked, total: rows.length, confirmed, mismatches, unknown }, null, 1));
      console.log(`checked ${checked}/${rows.length} confirmed=${confirmed} mismatches=${mismatches.length} unknown=${unknown.length}`);
    }
    await sleep(DELAY);
  }

  fs.writeFileSync(OUT, JSON.stringify({ done: true, checked, total: rows.length, confirmed, mismatches, unknown }, null, 1));
  console.log(`DONE checked=${checked} confirmed=${confirmed} mismatches=${mismatches.length} unknown=${unknown.length}`);
  console.log(JSON.stringify(mismatches, null, 1));
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
