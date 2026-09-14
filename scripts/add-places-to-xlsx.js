#!/usr/bin/env node
/**
 * Append the curated Ghana places (scripts/data/ghana-places.js) to the source
 * xlsx so future imports keep them, then they can be re-imported.
 *
 * Rows are written as: A=name, B=town, C=region, D='City / Town',
 * E=aliases, F=brief description. Existing names are skipped.
 *
 * Uses PowerShell's zip APIs (no npm dependency). A .bak copy is kept.
 *
 * Usage:
 *   node scripts/add-places-to-xlsx.js            # dry run (report only)
 *   node scripts/add-places-to-xlsx.js --apply    # write the xlsx
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const { GHANA_PLACES, REGION_CAPITALS, REGION_PRIORITY } = require('./data/ghana-places');

const XLSX_PATH = process.env.XLSX_PATH
  || path.resolve(__dirname, '../../../Downloads/ghana_attraction_sites_clean_with_histories.xlsx');
const APPLY = process.argv.includes('--apply');
const SHEET = 'xl/worksheets/sheet1.xml';
const TABLE = 'xl/tables/table1.xml';
const TMP = path.resolve(__dirname, '_xlsx_tmp');

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function ps(script) {
  const file = path.resolve(TMP, `_${Date.now()}_${Math.random().toString(36).slice(2)}.ps1`);
  fs.writeFileSync(file, script, 'utf8');
  try {
    return execSync(`powershell -ExecutionPolicy Bypass -File "${file}"`, { stdio: 'pipe' }).toString();
  } catch (e) {
    console.error('--- PowerShell failed ---');
    console.error('script:', script);
    console.error('stdout:', (e.stdout || '').toString());
    console.error('stderr:', (e.stderr || '').toString());
    throw e;
  } finally {
    try { fs.unlinkSync(file); } catch {}
  }
}

function extract(entries) {
  fs.mkdirSync(TMP, { recursive: true });
  const list = entries.map((e) => `'${e}'`).join(',');
  ps(`
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead("${XLSX_PATH.replace(/\\/g, '\\\\')}")
foreach ($n in @(${list})) {
  $e = $zip.GetEntry($n)
  $sr = [System.IO.StreamReader]::new($e.Open())
  $raw = $sr.ReadToEnd()
  $sr.Close()
  [System.IO.File]::WriteAllText("${TMP.replace(/\\/g, '\\\\')}\\" + ($n -replace '/', '_'), $raw)
}
$zip.Dispose()
`);
  return entries.map((e) => fs.readFileSync(path.resolve(TMP, e.replace(/\//g, '_')), 'utf8'));
}

function repack(entries) {
  const list = entries.map((e) => `'${e}'`).join(',');
  const work = path.resolve(TMP, 'out.xlsx');
  fs.copyFileSync(XLSX_PATH, work);
  ps(`
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$zip = [System.IO.Compression.ZipFile]::Open("${work.replace(/\\/g, '\\\\')}", [System.IO.Compression.ZipArchiveMode]::Update)
$enc = New-Object System.Text.UTF8Encoding($false)
foreach ($n in @(${list})) {
  $e = $zip.GetEntry($n)
  if ($e) { $e.Delete() }
  $new = $zip.CreateEntry($n)
  $sw = New-Object System.IO.StreamWriter($new.Open(), $enc)
  $sw.Write([System.IO.File]::ReadAllText("${TMP.replace(/\\/g, '\\\\')}\\" + ($n -replace '/', '_')))
  $sw.Close()
}
$zip.Dispose()
`);
  const afterSize = fs.statSync(work).size;
  console.log(`  repack temp: ${afterSize} bytes (orig: ${fs.statSync(XLSX_PATH).size})`);
  fs.copyFileSync(work, XLSX_PATH);
  console.log(`  copied back: ${fs.statSync(XLSX_PATH).size} bytes`);
}

function buildRow(rowNum, name, town, region, aliases, history) {
  const cells = [
    ['A', name],
    ['B', town],
    ['C', region],
    ['D', 'City / Town'],
    ['E', aliases],
    ['F', history],
  ];
  const inner = cells
    .map(([col, val]) => `<x:c r="${col}${rowNum}" s="15" t="str"><x:v>${xmlEscape(val)}</x:v></x:c>`)
    .join('');
  return `<x:row r="${rowNum}">${inner}</x:row>`;
}

function main() {
  if (!fs.existsSync(XLSX_PATH)) {
    console.error(`ERROR: xlsx not found at ${XLSX_PATH}`);
    process.exit(1);
  }

  console.log('=== Add Ghana Places to XLSX ===');
  console.log(`File: ${XLSX_PATH}`);
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`);
  console.log('');

  const [sheet, table] = extract([SHEET, TABLE]);

  // Existing names (column A) to avoid duplicates.
  const existing = new Set();
  const cellRe = /<x:c r="A(\d+)"[^>]*>(?:<x:v>([\s\S]*?)<\/x:v>)?/g;
  let m;
  while ((m = cellRe.exec(sheet)) !== null) {
    if (m[2]) existing.add(m[2].replace(/&amp;/g, '&').replace(/&#039;/g, "'").trim().toLowerCase());
  }

  const rowNums = [...sheet.matchAll(/<x:row r="(\d+)"/g)].map((x) => parseInt(x[1], 10));
  const lastRow = Math.max(...rowNums);

  const rows = [];
  const skipped = [];
  for (const [region, places] of Object.entries(GHANA_PLACES)) {
    const capital = REGION_CAPITALS[region];
    for (const name of places) {
      if (existing.has(name.toLowerCase())) { skipped.push(name); continue; }
      const isCapital = !!capital && name.toLowerCase() === capital.toLowerCase();
      const history = isCapital
        ? `Regional capital of the ${region} Region, Ghana.`
        : `Town in the ${region} Region, Ghana.`;
      rows.push({ name, town: name, region, aliases: `${name}, ${region} Region, Ghana`, history });
    }
  }

  console.log(`Last existing row: ${lastRow}`);
  console.log(`New rows to add:   ${rows.length}`);
  console.log(`Already present:   ${skipped.length}${skipped.length ? ' -> ' + skipped.slice(0, 8).join(', ') + (skipped.length > 8 ? ' …' : '') : ''}`);
  console.log('');

  if (!APPLY) {
    console.log('Sample row XML:');
    console.log('  ' + buildRow(lastRow + 1, rows[0].name, rows[0].town, rows[0].region, rows[0].aliases, rows[0].history).slice(0, 240) + '…');
    console.log('\n(dry run — nothing written)');
    return;
  }

  const newLast = lastRow + rows.length;
  const block = rows.map((r, i) => buildRow(lastRow + 1 + i, r.name, r.town, r.region, r.aliases, r.history)).join('');
  const newSheet = sheet.replace('</x:sheetData>', `${block}</x:sheetData>`);
  const newTable = table.replace(/ref="A1:F\d+"/, `ref="A1:F${newLast}"`);

  if (newSheet === sheet) throw new Error('sheet1.xml: </x:sheetData> not found');
  if (newTable === table) console.warn('WARN: table1.xml ref not updated (pattern not found)');

  fs.writeFileSync(path.resolve(TMP, SHEET.replace(/\//g, '_')), newSheet, 'utf8');
  fs.writeFileSync(path.resolve(TMP, TABLE.replace(/\//g, '_')), newTable, 'utf8');

  fs.copyFileSync(XLSX_PATH, `${XLSX_PATH}.bak`);
  repack([SHEET, TABLE]);

  console.log(`Wrote ${rows.length} rows (rows ${lastRow + 1}-${newLast}); table ref -> A1:F${newLast}`);
  console.log(`Backup: ${XLSX_PATH}.bak`);
  fs.rmSync(TMP, { recursive: true, force: true });
}

main();
