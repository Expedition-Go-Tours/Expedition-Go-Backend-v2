#!/usr/bin/env node
/**
 * Merge the researched datasets, dedupe GLOBALLY (the DB key is `name`), drop
 * anything already in the XLSX, and write merged.json + a per-region summary.
 *
 * Usage: node scripts/data/_research/merge.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const RESEARCH = path.resolve(__dirname);
const XLSX_PATH = process.env.XLSX_PATH
  || path.resolve(__dirname, '../../../../../Downloads/ghana_attraction_sites_clean_with_histories.xlsx');
const SHEET = 'xl/worksheets/sheet1.xml';
const TMP = path.resolve(__dirname, '_xlsx_tmp');
const OUT = path.resolve(RESEARCH, 'merged.json');

const REGIONS = [
  'Greater Accra', 'Ashanti', 'Central', 'Eastern', 'Western', 'Volta',
  'Bono', 'Bono East', 'Ahafo', 'Northern', 'Savannah', 'North East',
  'Upper East', 'Upper West', 'Oti', 'Western North',
];

const CATEGORIES = [
  'Heritage & History', 'Nature & Wildlife', 'Beach & Coast', 'Museum & Art',
  'Market & Craft', 'Religious & Sacred', 'Scenic & Hiking', 'Food & Agritourism',
  'Water & Amusement', 'Engineering & Infrastructure', 'Cultural Village', 'Urban Landmark',
];

function ps(script) {
  fs.mkdirSync(TMP, { recursive: true });
  const file = path.resolve(TMP, `_${Date.now()}_${Math.random().toString(36).slice(2)}.ps1`);
  fs.writeFileSync(file, script, 'utf8');
  try {
    return execSync(`powershell -ExecutionPolicy Bypass -File "${file}"`, { stdio: 'pipe' }).toString();
  } finally {
    try { fs.unlinkSync(file); } catch {}
  }
}

function readSheetXml() {
  fs.mkdirSync(TMP, { recursive: true });
  ps(`
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$zip = [System.IO.Compression.ZipFile]::OpenRead("${XLSX_PATH.replace(/\\/g, '\\\\')}")
$e = $zip.GetEntry('${SHEET}')
$sr = [System.IO.StreamReader]::new($e.Open())
$raw = $sr.ReadToEnd()
$sr.Close()
$zip.Dispose()
[System.IO.File]::WriteAllText("${TMP.replace(/\\/g, '\\\\')}\\sheet1.xml", $raw)
`);
  return fs.readFileSync(path.resolve(TMP, 'sheet1.xml'), 'utf8');
}

const unescape = (s) => String(s || '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#039;/g, "'");

function readExisting(xml) {
  const rows = [];
  const rowRe = /<x:row r="(\d+)"[^>]*>([\s\S]*?)<\/x:row>/g;
  let m;
  while ((m = rowRe.exec(xml)) !== null) {
    const cells = {};
    const cellRe = /<x:c r="([A-Z]+)\d+"[^>]*>(?:<x:v>([\s\S]*?)<\/x:v>)?/g;
    let c;
    while ((c = cellRe.exec(m[2])) !== null) cells[c[1]] = unescape(c[2]);
    if (!cells.A) continue;
    rows.push({ name: cells.A, town: cells.B || '', region: cells.C || '', category: cells.D || '' });
  }
  return rows;
}

/** Trim + collapse whitespace; keep the display form. */
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const key = (s) => clean(s).toLowerCase();

function main() {
  const files = ['group1.json', 'group2.json', 'group3.json', 'group4.json', 'group3-extra.json', 'group4-extra.json'];
  const groups = files.map((f) => JSON.parse(fs.readFileSync(path.join(RESEARCH, f), 'utf8')));

  const existing = readExisting(readSheetXml());
  const existingNames = new Set(existing.map((r) => key(r.name)));
  const existingAttractionsByRegion = {};
  for (const r of existing) {
    if (r.category === 'City / Town') continue;
    const reg = clean(r.region);
    if (!reg) continue;
    existingAttractionsByRegion[reg] = (existingAttractionsByRegion[reg] || 0) + 1;
  }

  // Merge by region.
  const merged = {};
  for (const region of REGIONS) merged[region] = { towns: [], attractions: [] };
  for (const g of groups) {
    for (const [region, data] of Object.entries(g.regions || {})) {
      if (!merged[region]) merged[region] = { towns: [], attractions: [] };
      merged[region].towns.push(...(data.towns || []));
      merged[region].attractions.push(...(data.attractions || []));
    }
  }

  // Global dedupe (name is the unique DB key).
  const seenNames = new Set(existingNames);
  const out = {};
  const warnings = [];
  for (const region of REGIONS) {
    const data = merged[region];
    const towns = [];
    const attractions = [];
    for (const t of data.towns) {
      const name = clean(t);
      const k = key(name);
      if (!k || seenNames.has(k)) continue;
      seenNames.add(k);
      towns.push({ name, region });
    }
    for (const a of data.attractions) {
      const name = clean(a.name);
      const k = key(name);
      if (!k || seenNames.has(k)) continue;
      const category = CATEGORIES.includes(a.category) ? a.category : null;
      if (!category) { warnings.push(`${region}: bad category "${a.category}" for ${name}`); continue; }
      seenNames.add(k);
      attractions.push({
        name,
        town: clean(a.town) || name,
        region,
        category,
        aliases: clean(a.aliases),
        description: clean(a.description),
      });
    }
    out[region] = { towns, attractions };
  }

  fs.writeFileSync(OUT, JSON.stringify({ regions: out }, null, 1), 'utf8');

  console.log('region           newTowns  newAttr  existing  TOTAL attr');
  let tT = 0; let tA = 0;
  for (const region of REGIONS) {
    const newTowns = out[region].towns.length;
    const newAttr = out[region].attractions.length;
    const existingAttr = existingAttractionsByRegion[region] || 0;
    tT += newTowns; tA += newAttr;
    const total = existingAttr + newAttr;
    const flag = total < 20 ? '  <-- BELOW 20' : '';
    console.log(
      `${region.padEnd(16)} ${String(newTowns).padStart(6)} ${String(newAttr).padStart(8)} ` +
      `${String(existingAttr).padStart(9)} ${String(total).padStart(10)}${flag}`,
    );
  }
  console.log(`\nNEW towns: ${tT}   NEW attractions: ${tA}`);
  if (warnings.length) console.log(`\nwarnings:\n  ${warnings.join('\n  ')}`);
  fs.rmSync(TMP, { recursive: true, force: true });
}

main();
