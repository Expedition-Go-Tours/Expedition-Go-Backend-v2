#!/usr/bin/env node
/**
 * Prune XLSX rows whose SLUG collides with an earlier row (e.g. "Kete Krachi"
 * vs "Kete-Krachi"). The importer keys `Attraction.slug` unique, so such a row
 * can never be created — it is a spelling variant of something already there.
 *
 * Keeps the FIRST occurrence in file order. Rewrites sheetData, renumbering rows.
 *
 * Usage:
 *   node scripts/data/_research/prune-xlsx-slugs.js           # dry run
 *   node scripts/data/_research/prune-xlsx-slugs.js --apply   # write
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

const unescape = (s) => String(s || '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#039;/g, "'");

const slugify = (n) => String(n || '')
  .toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function main() {
  const [sheet, table] = extract([SHEET, TABLE]);

  const rowRe = /<x:row r="(\d+)"[^>]*>([\s\S]*?)<\/x:row>/g;
  const rows = [];
  let m;
  while ((m = rowRe.exec(sheet)) !== null) rows.push({ num: +m[1], xml: m[2] });

  const nameOf = (xml) => {
    const a = /<x:c r="A\d+"[^>]*>(?:<x:v>([\s\S]*?)<\/x:v>)?/.exec(xml);
    return a && a[1] ? unescape(a[1]).replace(/\s+/g, ' ').trim() : '';
  };

  const seen = new Map(); // slug -> name
  const keep = [];
  const dropped = [];
  for (const row of rows) {
    const name = nameOf(row.xml);
    if (row.num === 1 || !name) { keep.push(row); continue; }
    const slug = slugify(name);
    if (seen.has(slug)) { dropped.push({ name, slug, kept: seen.get(slug) }); continue; }
    seen.set(slug, name);
    keep.push(row);
  }

  console.log(`rows: ${rows.length}  keep: ${keep.length}  drop: ${dropped.length}`);
  for (const d of dropped) console.log(`  DROP "${d.name}" (slug "${d.slug}" already used by "${d.kept}")`);
  if (!dropped.length) { console.log('nothing to prune'); return; }
  if (!APPLY) { console.log('\n(dry run — nothing written)'); return; }

  // Rebuild sheetData with renumbered rows/cells.
  const rebuilt = keep.map((row, i) => {
    const newNum = i + 1;
    const inner = row.xml.replace(/(<x:c r=")([A-Z]+)\d+(")/g, `$1$2${newNum}$3`);
    return `<x:row r="${newNum}">${inner}</x:row>`;
  }).join('');

  const newSheet = sheet.replace(
    /<x:sheetData>[\s\S]*<\/x:sheetData>/,
    `<x:sheetData>${rebuilt}</x:sheetData>`,
  );
  if (newSheet === sheet) throw new Error('sheetData not replaced');
  const newTable = table.replace(/ref="A1:F\d+"/, `ref="A1:F${keep.length}"`);

  fs.writeFileSync(path.resolve(TMP, SHEET.replace(/\//g, '_')), newSheet, 'utf8');
  fs.writeFileSync(path.resolve(TMP, TABLE.replace(/\//g, '_')), newTable, 'utf8');
  fs.copyFileSync(XLSX_PATH, `${XLSX_PATH}.bak3`);
  repack([SHEET, TABLE]);
  console.log(`Wrote ${keep.length} rows; table ref -> A1:F${keep.length}`);
  console.log(`Backup: ${XLSX_PATH}.bak3`);
  fs.rmSync(TMP, { recursive: true, force: true });
}

main();
