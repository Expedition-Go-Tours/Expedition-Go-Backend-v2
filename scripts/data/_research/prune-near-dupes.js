#!/usr/bin/env node
/**
 * Remove NEW attractions (merged.json) that duplicate one that already existed.
 *
 * Rule (deliberately asymmetric): prune the new entry only when its normalised
 * token set is a SUBSET of the existing name's (or equal). That catches
 * "Tema Harbour" vs "Tema Harbour / Fishing Harbour" and "Nakore Mosque" vs
 * "Nakore Ancient Mosque", while KEEPING a new name that adds a distinguishing
 * word ("Fort William Lighthouse" vs "Fort William" are different sites).
 *
 * Removes from both the DB and the XLSX.
 *
 * Usage:
 *   node scripts/data/_research/prune-near-dupes.js            # report only
 *   node scripts/data/_research/prune-near-dupes.js --apply    # remove
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const RESEARCH = path.resolve(__dirname);
const XLSX = process.env.XLSX_PATH
  || path.resolve(__dirname, '../../../../../Downloads/ghana_attraction_sites_clean_with_histories.xlsx');
const BACKUP = `${XLSX}.bak2`;
const SHEET = 'xl/worksheets/sheet1.xml';
const TABLE = 'xl/tables/table1.xml';
const TMP = path.resolve(RESEARCH, '_xlsx_tmp');
const APPLY = process.argv.includes('--apply');

const STOP = new Set(['the', 'and', 'of', 'a', 'an', 'in', 'at', 'on', 'de', 'la', 'ghana']);
const tokens = (n) => new Set(
  String(n || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/).filter((t) => t && !STOP.has(t)),
);

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

function namesFromXlsx(file) {
  fs.mkdirSync(TMP, { recursive: true });
  ps(`
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$zip = [System.IO.Compression.ZipFile]::OpenRead("${file.replace(/\\/g, '\\\\')}")
$e = $zip.GetEntry('xl/worksheets/sheet1.xml')
$sr = [System.IO.StreamReader]::new($e.Open())
$raw = $sr.ReadToEnd(); $sr.Close(); $zip.Dispose()
[System.IO.File]::WriteAllText("${TMP.replace(/\\/g, '\\\\')}\\tmp.xml", $raw)
`);
  const xml = fs.readFileSync(path.resolve(TMP, 'tmp.xml'), 'utf8');
  const out = [];
  const rowRe = /<x:row r="(\d+)"[^>]*>([\s\S]*?)<\/x:row>/g;
  let m;
  while ((m = rowRe.exec(xml)) !== null) {
    const a = /<x:c r="A\d+"[^>]*>(?:<x:v>([\s\S]*?)<\/x:v>)?/.exec(m[2]);
    const d = /<x:c r="D\d+"[^>]*>(?:<x:v>([\s\S]*?)<\/x:v>)?/.exec(m[2]);
    if (a && a[1]) out.push({ name: unescape(a[1]).trim(), category: d && d[1] ? unescape(d[1]) : '' });
  }
  return out;
}

function main() {
  const existing = namesFromXlsx(BACKUP).filter((r) => r.category !== 'City / Town');
  const merged = JSON.parse(fs.readFileSync(path.join(RESEARCH, 'merged.json'), 'utf8'));

  const existingToks = existing.map((r) => ({ name: r.name, t: tokens(r.name) }));
  const toPrune = [];
  const kept = [];
  for (const [region, data] of Object.entries(merged.regions)) {
    for (const a of data.attractions) {
      const t = tokens(a.name);
      if (t.size < 2) continue;
      let hit = null;
      for (const e of existingToks) {
        if (e.t.size < 2) continue;
        let subset = true;
        for (const x of t) if (!e.t.has(x)) { subset = false; break; }
        if (subset && e.t.size - t.size <= 2) { hit = e.name; break; }
      }
      if (hit) toPrune.push({ region, name: a.name, duplicates: hit });
      else kept.push(a.name);
    }
  }

  console.log(`new attractions: ${Object.values(merged.regions).reduce((n, d) => n + d.attractions.length, 0)}`);
  console.log(`to prune (new is a subset of an existing name): ${toPrune.length}\n`);
  for (const p of toPrune) console.log(`  [${p.region}] "${p.name}"  ~  "${p.duplicates}"`);
  console.log(`\nkept as distinct (adds a distinguishing word): ${kept.length}`);
  for (const k of kept) console.log(`  ${k}`);

  fs.writeFileSync(path.join(RESEARCH, 'near-dupes.json'), JSON.stringify(toPrune, null, 1), 'utf8');
  if (!APPLY) { console.log('\n(wrote near-dupes.json; dry run)'); return; }

  const removeSet = new Set(toPrune.map((p) => p.name.toLowerCase()));

  // 1. DB
  const script = `
const p = require("./utils/prismaClient");
(async () => {
  const names = ${JSON.stringify(toPrune.map((p) => p.name))};
  const del = await p.attraction.deleteMany({ where: { name: { in: names } } });
  console.log("db deleted:", del.count);
  process.exit(0);
})().catch(e => { console.error("ERR", e.message); process.exit(1); });
`;
  const out = execSync('ssh -i C:\\Users\\itope\\.ssh\\hetzner_new deploy@2.28.45.181 "cd /home/deploy/Expedition-Go-Backend-v2 && node -"',
    { input: script, stdio: ['pipe', 'pipe', 'pipe'] }).toString();
  console.log(out.trim());

  // 2. XLSX
  const [sheet, table] = extract([SHEET, TABLE]);
  const rowRe = /<x:row r="(\d+)"[^>]*>([\s\S]*?)<\/x:row>/g;
  const rows = [];
  let m;
  while ((m = rowRe.exec(sheet)) !== null) rows.push({ num: +m[1], xml: m[2] });
  const nameOf = (xml) => {
    const a = /<x:c r="A\d+"[^>]*>(?:<x:v>([\s\S]*?)<\/x:v>)?/.exec(xml);
    return a && a[1] ? unescape(a[1]).replace(/\s+/g, ' ').trim() : '';
  };
  const keep = rows.filter((r) => r.num === 1 || !removeSet.has(nameOf(r.xml).toLowerCase()));
  const rebuilt = keep.map((row, i) => {
    const n = i + 1;
    return `<x:row r="${n}">${row.xml.replace(/(<x:c r=")([A-Z]+)\d+(")/g, `$1$2${n}$3`)}</x:row>`;
  }).join('');
  const newSheet = sheet.replace(/<x:sheetData>[\s\S]*<\/x:sheetData>/, `<x:sheetData>${rebuilt}</x:sheetData>`);
  if (newSheet === sheet) throw new Error('sheetData not replaced');
  fs.writeFileSync(path.resolve(TMP, SHEET.replace(/\//g, '_')), newSheet, 'utf8');
  fs.writeFileSync(path.resolve(TMP, TABLE.replace(/\//g, '_')), table.replace(/ref="A1:F\d+"/, `ref="A1:F${keep.length}"`), 'utf8');
  fs.copyFileSync(XLSX, `${XLSX}.bak4`);
  repack([SHEET, TABLE]);
  console.log(`xlsx: removed ${rows.length - keep.length} rows -> ${keep.length} rows`);
  fs.rmSync(TMP, { recursive: true, force: true });
}

main();
