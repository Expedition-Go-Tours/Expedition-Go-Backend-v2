#!/usr/bin/env node
/** Quick QA over merged.json before it is imported. */
'use strict';
const fs = require('fs');
const path = require('path');
const merged = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'merged.json'), 'utf8'));

const SITE_WORDS = /\b(park|castle|fort|museum|falls|waterfall|reserve|sanctuary|forest|lake|river|beach|palace|cathedral|mosque|shrine|market|garden|gardens|dam|bridge|zoo|mine|hill|hills|mountain|mountains|island|estuary|lagoon|centre|center|stadium|university|hospital|theatre|theater)\b/i;

let bad = 0;
for (const [region, data] of Object.entries(merged.regions)) {
  const townNames = new Set(data.towns.map((t) => t.name.toLowerCase()));
  const dupes = data.attractions.filter((a) => townNames.has(a.name.toLowerCase()));
  if (dupes.length) console.log(`[${region}] attraction name collides with a town: ${dupes.map((d) => d.name).join(', ')}`);
  const sitey = data.towns.filter((t) => SITE_WORDS.test(t.name));
  if (sitey.length) console.log(`[${region}] town looks like a site: ${sitey.map((t) => t.name).join(', ')}`);
  const noDesc = data.attractions.filter((a) => !a.description || a.description.length < 20);
  if (noDesc.length) console.log(`[${region}] thin description: ${noDesc.map((a) => a.name).join(', ')}`);
  const noAlias = data.attractions.filter((a) => !a.aliases);
  if (noAlias.length) console.log(`[${region}] no aliases: ${noAlias.map((a) => a.name).join(', ')}`);
  bad += dupes.length + sitey.length + noDesc.length + noAlias.length;
}

console.log('\n--- samples ---');
for (const [region, data] of Object.entries(merged.regions)) {
  console.log(`\n${region}  (towns ${data.towns.length}, attractions ${data.attractions.length})`);
  for (const a of data.attractions.slice(0, 4)) console.log(`   ${a.name} [${a.category}] @ ${a.town}`);
}
console.log(`\nissues: ${bad}`);
