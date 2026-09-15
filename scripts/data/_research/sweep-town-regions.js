#!/usr/bin/env node
/**
 * Sweep every City/Town row and compare its stored region against the
 * geocoder's. Writes results to scripts/data/_research/town-region-sweep.json.
 *
 * ⚠️ The geocoder is NOT authoritative for this. A full sweep flagged ~15% of
 * rows, but spot-checking showed most flags are the GEOCODER being wrong — it
 * puts Akropong / Akuapem-Mampong / Anyinam (Eastern) in Ashanti, Asokwa
 * (Ashanti) in Central, Bodi (Western North) in Savannah, and still returns the
 * pre-2019 "Brong-Ahafo" region name. Treat the output as leads to verify by
 * hand (e.g. against district capitals), never as a fix list.
 *
 * Usage: node scripts/data/_research/sweep-town-regions.js [--delayMs=250]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const prisma = require('../../../utils/prismaClient');
const { geocodedRegionFor, normalizeRegion } = require('../../../utils/placeResolver');

const OUT = path.resolve(__dirname, 'town-region-sweep.json');
const delayArg = process.argv.find((a) => a.startsWith('--delayMs='));
const DELAY = delayArg ? parseInt(delayArg.split('=')[1], 10) : 250;

(async () => {
  const rows = await prisma.attraction.findMany({
    where: { status: 'ACTIVE', category: 'City / Town' },
    select: { name: true, region: true },
    orderBy: { name: 'asc' },
  });

  const mismatches = [];
  const unknown = [];
  let checked = 0;

  for (const r of rows) {
    let geo = null;
    try {
      geo = await geocodedRegionFor(r.name, { expeditionOnly: true });
    } catch { geo = null; }
    checked++;
    if (!geo) {
      unknown.push(r.name);
    } else if (normalizeRegion(geo).toLowerCase() !== normalizeRegion(r.region).toLowerCase()) {
      mismatches.push({ name: r.name, stored: r.region, geocoder: normalizeRegion(geo) });
    }
    if (checked % 25 === 0) {
      fs.writeFileSync(OUT, JSON.stringify({ done: false, checked, total: rows.length, mismatches, unknown: unknown.length }, null, 1));
      console.log(`checked ${checked}/${rows.length} mismatches=${mismatches.length} unknown=${unknown.length}`);
    }
    await new Promise((res) => setTimeout(res, DELAY));
  }

  fs.writeFileSync(OUT, JSON.stringify({ done: true, checked, total: rows.length, mismatches, unknown }, null, 1));
  console.log(`DONE checked=${checked} mismatches=${mismatches.length} unknown=${unknown.length}`);
  console.log(JSON.stringify(mismatches, null, 1));
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
