#!/usr/bin/env node
/**
 * Append the merged research dataset (scripts/data/_research/merged.json) to the
 * source XLSX: new towns as `City / Town` rows and new attractions with their
 * category/aliases/description. Existing names are skipped, so it is safe to
 * re-run.
 *
 * Uses PowerShell's zip APIs (no npm dependency). Keeps a .bak copy.
 *
 * Usage:
 *   node scripts/data/_research/append-to-xlsx.js            # dry run
 *   node scripts/data/_research/append-to-xlsx.js --apply    # write
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const RESEARCH = path.resolve(__dirname);
const XLSX_PATH = process.env.XLSX_PATH
  || path.resolve(__dirname, '../../../../../Downloads/ghana_attraction_sites_clean_with_histories.xlsx');
const SHEET = 'xl/worksheets/sheet1.xml';
const TABLE = 'xl/tables/table1.xml';
const TMP = path.resolve(RESEARCH, '_xlsx_tmp');
const APPLY = process.argv.includes('--apply');

const REGION_LABEL = (r) => `${r} Region`;

function ps(script) {
  fs.mkdirSync(TMP, { recursive: true });
  const file = path.resolve(TMP, `_${Date.now()}_${Math.random().toString(36).slice(2)}.ps1`);
  fs.writeFileSync(file, script, 'utf8');
  try {
    return execSync(`powershell -ExecutionPolicy Bypass -File "${file}"`, { stdio: 'pipe' }).toString();
  } catch (e) {
    console.error('--- PowerShell failed ---');
    console.error(script);
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
  fs.copyFileSync(work, XLSX_PATH);
}

const xmlEscape = (s) => String(s || '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#039;');

const unescape = (s) => String(s || '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#039;/g, "'");

function buildRow(rowNum, a, b, c, d, e, f) {
  const cells = [['A', a], ['B', b], ['C', c], ['D', d], ['E', e], ['F', f]];
  const inner = cells
    .map(([col, val]) => `<x:c r="${col}${rowNum}" s="15" t="str"><x:v>${xmlEscape(val)}</x:v></x:c>`)
    .join('');
  return `<x:row r="${rowNum}">${inner}</x:row>`;
}

function main() {
  if (!fs.existsSync(XLSX_PATH)) throw new Error(`xlsx not found: ${XLSX_PATH}`);
  const merged = JSON.parse(fs.readFileSync(path.join(RESEARCH, 'merged.json'), 'utf8'));

  const [sheet, table] = extract([SHEET, TABLE]);

  const existing = new Set();
  const cellRe = /<x:c r="A(\d+)"[^>]*>(?:<x:v>([\s\S]*?)<\/x:v>)?/g;
  let m;
  while ((m = cellRe.exec(sheet)) !== null) {
    if (m[2]) existing.add(unescape(m[2]).replace(/\s+/g, ' ').trim().toLowerCase());
  }

  const rowNums = [...sheet.matchAll(/<x:row r="(\d+)"/g)].map((x) => parseInt(x[1], 10));
  const lastRow = Math.max(...rowNums);

  const rows = [];
  for (const [region, data] of Object.entries(merged.regions)) {
    for (const t of data.towns) {
      const name = String(t.name).trim();
      if (existing.has(name.toLowerCase())) continue;
      existing.add(name.toLowerCase());
      rows.push([
        name, name, region, 'City / Town',
        `${name}, ${REGION_LABEL(region)}, Ghana`,
        `Town in the ${REGION_LABEL(region)}, Ghana.`,
      ]);
    }
    for (const a of data.attractions) {
      const name = String(a.name).trim();
      if (existing.has(name.toLowerCase())) continue;
      existing.add(name.toLowerCase());
      rows.push([name, a.town || name, region, a.category, a.aliases || '', a.description || '']);
    }
  }

  console.log(`Last existing row: ${lastRow}`);
  console.log(`New rows to add:   ${rows.length}`);
  const towns = rows.filter((r) => r[3] === 'City / Town').length;
  console.log(`  towns: ${towns}   attractions: ${rows.length - towns}`);
  if (!rows.length) { console.log('nothing to do'); return; }
  if (!APPLY) {
    console.log('\nSample rows:');
    for (const r of rows.slice(0, 3)) console.log('  ', JSON.stringify(r));
    console.log('\n(dry run — nothing written)');
    return;
  }

  const newLast = lastRow + rows.length;
  const block = rows.map((r, i) => buildRow(lastRow + 1 + i, ...r)).join('');
  const newSheet = sheet.replace('</x:sheetData>', `${block}</x:sheetData>`);
  const newTable = table.replace(/ref="A1:F\d+"/, `ref="A1:F${newLast}"`);
  if (newSheet === sheet) throw new Error('sheet1.xml: </x:sheetData> not found');

  fs.writeFileSync(path.resolve(TMP, SHEET.replace(/\//g, '_')), newSheet, 'utf8');
  fs.writeFileSync(path.resolve(TMP, TABLE.replace(/\//g, '_')), newTable, 'utf8');

  fs.copyFileSync(XLSX_PATH, `${XLSX_PATH}.bak2`);
  repack([SHEET, TABLE]);
  console.log(`Wrote ${rows.length} rows (rows ${lastRow + 1}-${newLast}); table ref -> A1:F${newLast}`);
  console.log(`Backup: ${XLSX_PATH}.bak2`);
  fs.rmSync(TMP, { recursive: true, force: true });
}

main();
