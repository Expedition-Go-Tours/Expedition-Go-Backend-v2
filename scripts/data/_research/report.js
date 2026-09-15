#!/usr/bin/env node
/**
 * Merge the researched region datasets (scripts/data/_research/group*.json)
 * and report what is genuinely new against the existing XLSX, so we can append
 * without duplicates.
 *
 * Usage: node scripts/data/_research/report.js
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

const REGIONS = [
  'Greater Accra', 'Ashanti', 'Central', 'Eastern', 'Western', 'Volta',
  'Bono', 'Bono East', 'Ahafo', 'Northern', 'Savannah', 'North East',
  'Upper East', 'Upper West', 'Oti', 'Western North',
];

function ps(script) {
  const file = path.resolve(TMP, `_${Date.now()}_${Math.random().toString(36).slice(2)}.ps1`);
  fs.mkdirSync(TMP, { recursive: true });
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

function unescape(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'");
}

/** Existing XLSX rows as { name, town, region, category }. */
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

function main() {
  const groups = [1, 2, 3, 4].map((n) => {
    const f = path.join(RESEARCH, `group${n}.json`);
    if (!fs.existsSync(f)) throw new Error(`missing ${f}`);
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  });

  const existing = readExisting(readSheetXml());
  const existingNames = new Set(existing.map((r) => r.name.trim().toLowerCase()));
  console.log(`existing XLSX rows: ${existing.length}`);

  // Merge the four groups by region.
  const merged = {};
  for (const g of groups) {
    for (const [region, data] of Object.entries(g.regions || {})) {
      if (!merged[region]) merged[region] = { towns: [], attractions: [] };
      merged[region].towns.push(...(data.towns || []));
      merged[region].attractions.push(...(data.attractions || []));
    }
  }

  const unknown = Object.keys(merged).filter((r) => !REGIONS.includes(r));
  if (unknown.length) console.log(`WARNING unknown regions: ${unknown.join(', ')}`);

  console.log('\nregion           towns(new/total)  attr(new/total)  dupNames');
  let totTownsNew = 0;
  let totAttrNew = 0;
  for (const region of REGIONS) {
    const data = merged[region] || { towns: [], attractions: [] };
    const seenTown = new Set();
    const seenAttr = new Set();
    let townsNew = 0;
    let attrNew = 0;
    const dups = [];
    for (const t of data.towns) {
      const k = String(t).trim().toLowerCase();
      if (!k || seenTown.has(k)) continue;
      seenTown.add(k);
      if (existingNames.has(k)) dups.push(`town:${t}`);
      else townsNew++;
    }
    for (const a of data.attractions) {
      const k = String(a.name || '').trim().toLowerCase();
      if (!k || seenAttr.has(k)) continue;
      seenAttr.add(k);
      if (existingNames.has(k)) dups.push(`attr:${a.name}`);
      else attrNew++;
    }
    totTownsNew += townsNew;
    totAttrNew += attrNew;
    console.log(
      `${region.padEnd(16)} ${String(townsNew).padStart(4)}/${String(seenTown.size).padEnd(4)}      ` +
      `${String(attrNew).padStart(4)}/${String(seenAttr.size).padEnd(4)}    ${dups.length}`,
    );
    if (dups.length) console.log(`    dupes: ${dups.slice(0, 8).join(', ')}${dups.length > 8 ? ' …' : ''}`);
  }
  console.log(`\nNEW towns: ${totTownsNew}   NEW attractions: ${totAttrNew}`);
  fs.rmSync(TMP, { recursive: true, force: true });
}

main();
