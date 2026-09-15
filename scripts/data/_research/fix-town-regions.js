#!/usr/bin/env node
/**
 * Correct mis-assigned City/Town regions in both the DB and the source XLSX.
 *
 * Usage:
 *   node scripts/data/_research/fix-town-regions.js            # dry run
 *   node scripts/data/_research/fix-town-regions.js --apply
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const RESEARCH = path.resolve(__dirname);
const XLSX = process.env.XLSX_PATH
  || path.resolve(__dirname, '../../../../../Downloads/ghana_attraction_sites_clean_with_histories.xlsx');
const SHEET = 'xl/worksheets/sheet1.xml';
const TABLE = 'xl/tables/table1.xml';
const TMP = path.resolve(RESEARCH, '_xlsx_tmp');
const APPLY = process.argv.includes('--apply');

/** name -> correct region */
const FIXES = JSON.parse(fs.readFileSync(path.join(RESEARCH, 'town-region-fixes.json'), 'utf8'));

function ps(script) {
  fs.mkdirSync(TMP, { recursive: true });
  const f = path.resolve(TMP, `_${Date.now()}_${Math.random().toString(36).slice(2)}.ps1`);
  fs.writeFileSync(f, script, 'utf8');
  try { return execSync(`powershell -ExecutionPolicy Bypass -File "${f}"`, { stdio: 'pipe' }).toString(); }
  catch (e) { console.error(script); console.error('stderr:', (e.stderr || '').toString()); throw e; }
  finally { try { fs.unlinkSync(f); } catch {} }
}

function extract(entries) {
  fs.mkdirSync(TMP, { recursive: true });
  const list = entries.map((e) => `'${e}'`).join(',');
  ps(`
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead("${XLSX.replace(/\\/g, '\\\\')}")
foreach ($n in @(${list})) {
  $e = $zip.GetEntry($n)
  $sr = [System.IO.StreamReader]::new($e.Open())
  $raw = $sr.ReadToEnd(); $sr.Close()
  [System.IO.File]::WriteAllText("${TMP.replace(/\\/g, '\\\\')}\\" + ($n -replace '/', '_'), $raw)
}
$zip.Dispose()
`);
  return entries.map((e) => fs.readFileSync(path.resolve(TMP, e.replace(/\//g, '_')), 'utf8'));
}

function repack(entries) {
  const list = entries.map((e) => `'${e}'`).join(',');
  const work = path.resolve(TMP, 'out.xlsx');
  fs.copyFileSync(XLSX, work);
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
  fs.copyFileSync(work, XLSX);
}

const unescape = (s) => String(s || '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#039;/g, "'");
const escapeXml = (s) => String(s || '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#039;');

function main() {
  console.log('region fixes:', JSON.stringify(FIXES, null, 1));
  if (!APPLY) { console.log('(dry run)'); return; }

  // 1. DB
  const script = `
const p = require("./utils/prismaClient");
(async () => {
  const fixes = ${JSON.stringify(FIXES)};
  let n = 0;
  for (const [name, region] of Object.entries(fixes)) {
    const r = await p.attraction.updateMany({ where: { name, category: "City / Town" }, data: { region } });
    console.log(name, "->", region, "rows:", r.count);
    n += r.count;
  }
  console.log("db rows updated:", n);
  process.exit(0);
})().catch(e => { console.error("ERR", e.message); process.exit(1); });
`;
  const out = execSync('ssh -i C:\\Users\\itope\\.ssh\\hetzner_new deploy@2.28.45.181 "cd /home/deploy/Expedition-Go-Backend-v2 && node -"',
    { input: script, stdio: ['pipe', 'pipe', 'pipe'] }).toString();
  console.log(out.trim());

  // 2. XLSX — rewrite the C cell for the affected rows
  const [sheet, table] = extract([SHEET, TABLE]);
  const rowRe = /<x:row r="(\d+)"[^>]*>([\s\S]*?)<\/x:row>/g;
  let changed = 0;
  const rebuilt = sheet.replace(rowRe, (whole, num, inner) => {
    const a = /<x:c r="A\d+"[^>]*>(?:<x:v>([\s\S]*?)<\/x:v>)?/.exec(inner);
    if (!a || !a[1]) return whole;
    const name = unescape(a[1]).replace(/\s+/g, ' ').trim();
    const region = FIXES[name];
    if (!region) return whole;
    const c = /<x:c r="C\d+"[^>]*>(?:<x:v>([\s\S]*?)<\/x:v>)?/.exec(inner);
    if (!c || unescape(c[1]) === region) return whole;
    changed++;
    const newInner = inner.replace(
      /<x:c r="C\d+"[^>]*>(?:<x:v>([\s\S]*?)<\/x:v>)?/,
      `<x:c r="C${num}" s="15" t="str"><x:v>${escapeXml(region)}</x:v></x:c>`,
    );
    return `<x:row r="${num}">${newInner}</x:row>`;
  });
  fs.writeFileSync(path.resolve(TMP, SHEET.replace(/\//g, '_')), rebuilt, 'utf8');
  fs.writeFileSync(path.resolve(TMP, TABLE.replace(/\//g, '_')), table, 'utf8');
  fs.copyFileSync(XLSX, `${XLSX}.bak5`);
  repack([SHEET, TABLE]);
  console.log(`xlsx: ${changed} region cell(s) rewritten; backup ${XLSX}.bak5`);
  fs.rmSync(TMP, { recursive: true, force: true });
}

main();
