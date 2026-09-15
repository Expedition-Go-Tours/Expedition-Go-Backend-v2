#!/usr/bin/env node
/**
 * Regenerate scripts/data/ghana-places.js from the authoritative City/Town rows
 * (scripts/data/_research/towns.json, dumped from the DB), keeping the
 * REGION_CAPITALS / REGION_PRIORITY maps from the existing file.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const RESEARCH = path.resolve(__dirname);
const TARGET = path.resolve(__dirname, '..', 'ghana-places.js');

const REGIONS = [
  'Greater Accra', 'Ashanti', 'Central', 'Eastern', 'Western', 'Volta',
  'Bono', 'Bono East', 'Ahafo', 'Northern', 'Savannah', 'North East',
  'Upper East', 'Upper West', 'Oti', 'Western North',
];

const towns = JSON.parse(fs.readFileSync(path.join(RESEARCH, 'towns.json'), 'utf8'));
const byRegion = {};
for (const t of towns) (byRegion[t.region] = byRegion[t.region] || []).push(t.name);
for (const r of Object.keys(byRegion)) byRegion[r].sort((a, b) => a.localeCompare(b));

const current = fs.readFileSync(TARGET, 'utf8');
const capitalsBlock = current.match(/const REGION_CAPITALS = \{[\s\S]*?\n\};/);
const priorityBlock = current.match(/const REGION_PRIORITY = \{[\s\S]*?\n\};/);
if (!capitalsBlock || !priorityBlock) throw new Error('could not find REGION_CAPITALS / REGION_PRIORITY in the current file');

function fmtRegion(region) {
  const names = byRegion[region] || [];
  const key = /[^A-Za-z]/.test(region) ? `'${region}'` : region;
  const lines = [];
  let line = '    ';
  for (const n of names) {
    const item = `'${n.replace(/'/g, "\\'")}', `;
    if (line.length + item.length > 92) { lines.push(line.trimEnd()); line = '    '; }
    line += item;
  }
  if (line.trim()) lines.push(line.trimEnd());
  return `  ${key}: [\n${lines.join('\n')}\n  ],`;
}

const body = REGIONS.map(fmtRegion).join('\n');

const out = `'use strict';

/**
 * Commonly-searched Ghanaian cities and towns, grouped by the 16 administrative
 * regions. Seeded into the Attraction table as \`category: 'City / Town'\` rows so
 * the search dropdown can autocomplete places that have no tours yet — clicking
 * one resolves the region and falls back to nearby tours.
 *
 * Generated from the curated XLSX import (see scripts/data/_research/). Keep the
 * region names bare (no "Region" suffix) to match the Attraction table
 * convention and the REGION_PRIORITY / REGION_CAPITALS maps in the importer.
 */

const GHANA_PLACES = {
${body}
};

${capitalsBlock[0]}

${priorityBlock[0]}

module.exports = { GHANA_PLACES, REGION_CAPITALS, REGION_PRIORITY };
`;

fs.writeFileSync(TARGET, out, 'utf8');
const total = Object.values(byRegion).reduce((n, l) => n + l.length, 0);
console.log(`wrote ${TARGET} with ${total} towns across ${Object.keys(byRegion).length} regions`);
