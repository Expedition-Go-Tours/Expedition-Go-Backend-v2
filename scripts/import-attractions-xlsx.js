#!/usr/bin/env node
/**
 * Import curated Ghana attractions from the xlsx file into the Attraction table.
 *
 * The xlsx has columns: A=Attraction Name, B=Town/Area, C=Region, D=Category,
 * E=Search Aliases / Keywords, F=Brief History / Story
 *
 * Usage:
 *   node scripts/import-attractions-xlsx.js --apply          # actually write
 *   node scripts/import-attractions-xlsx.js --dry-run        # preview only
 *   node scripts/import-attractions-xlsx.js --apply --limit=50  # first 50 rows
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const XLSX_PATH = process.env.XLSX_PATH || path.resolve(__dirname, '../../../Downloads/ghana_attraction_sites_clean_with_histories.xlsx');
const APPLY = process.argv.includes('--apply');
const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT_ARG = process.argv.find(a => a.startsWith('--limit='));
const LIMIT = LIMIT_ARG ? parseInt(LIMIT_ARG.split('=')[1], 10) : 0;

/** Ghana region population tier for auto-assigning priority */
const REGION_PRIORITY = {
  'Greater Accra': 'Very High',
  'Ashanti': 'High',
  'Central': 'High',
  'Western': 'Medium',
  'Eastern': 'Medium',
  'Volta': 'Medium',
  'Bono': 'Medium',
  'Northern': 'Medium',
  'Oti': 'Medium',
  'Bono East': 'Medium',
  'Ahafo': 'Standard',
  'Savannah': 'Standard',
  'North East': 'Standard',
  'Upper East': 'Standard',
  'Upper West': 'Standard',
  'Western North': 'Standard',
};

/** Region capitals for auto-assigning placeType */
const REGION_CAPITALS = {
  'Greater Accra': 'Accra',
  'Ashanti': 'Kumasi',
  'Central': 'Cape Coast',
  'Eastern': 'Koforidua',
  'Western': 'Sekondi-Takoradi',
  'Volta': 'Ho',
  'Bono': 'Sunyani',
  'Northern': 'Tamale',
  'Oti': 'Dambai',
  'Bono East': 'Techiman',
  'Ahafo': 'Goaso',
  'Savannah': 'Damongo',
  'North East': 'Nalerigu',
  'Upper East': 'Bolgatanga',
  'Upper West': 'Wa',
  'Western North': 'Sefwi Wiawso',
};

function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Extract sheet1.xml content from the xlsx zip (cross-platform: unzip on Linux, PowerShell on Windows) */
function extractSheetFromXlsx(xlsxPath) {
  const tmpXml = path.resolve(__dirname, '_tmp_sheet1.xml');
  const isWin = process.platform === 'win32';

  if (isWin) {
    const ps = `
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead("${xlsxPath.replace(/\\/g, '\\\\')}")
$sh = $zip.GetEntry("xl/worksheets/sheet1.xml")
$sr = [System.IO.StreamReader]::new($sh.Open())
$raw = $sr.ReadToEnd()
$sr.Close()
$zip.Dispose()
[System.IO.File]::WriteAllText("${tmpXml.replace(/\\/g, '\\\\')}", $raw)
`;
    const psTmp = path.resolve(__dirname, '_tmp_extract.ps1');
    fs.writeFileSync(psTmp, ps, 'utf8');
    try {
      execSync(`powershell -ExecutionPolicy Bypass -File "${psTmp}"`, { stdio: 'pipe' });
    } finally {
      try { fs.unlinkSync(psTmp); } catch {}
    }
  } else {
    execSync(`unzip -p "${xlsxPath}" xl/worksheets/sheet1.xml > "${tmpXml}"`, { stdio: 'pipe' });
  }

  const xml = fs.readFileSync(tmpXml, 'utf8');
  try { fs.unlinkSync(tmpXml); } catch {}
  return xml;
}

/** Parse the sheet XML and return rows as arrays of cell values */
function parseSheetXml(xml) {
  const rows = [];
  // Match each <x:row> block
  const rowRegex = /<x:row\s[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/x:row>/g;
  let rowMatch;
  while ((rowMatch = rowRegex.exec(xml)) !== null) {
    const rowNum = parseInt(rowMatch[1], 10);
    const rowContent = rowMatch[2];
    const cells = {};
    // Match each <x:c> cell
    const cellRegex = /<x:c\s[^>]*r="([A-Z]+)(\d+)"[^>]*>(?:<x:v>([\s\S]*?)<\/x:v>)?/g;
    let cellMatch;
    while ((cellMatch = cellRegex.exec(rowContent)) !== null) {
      const col = cellMatch[1];
      const val = cellMatch[3] ? cellMatch[3].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#039;/g, "'") : '';
      cells[col] = val;
    }
    rows.push({ rowNum, cells });
  }
  return rows;
}

async function main() {
  console.log('=== Ghana Attraction Import ===');
  console.log(`Source: ${XLSX_PATH}`);
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`);
  if (LIMIT) console.log(`Limit: ${LIMIT} rows`);
  console.log('');

  if (!fs.existsSync(XLSX_PATH)) {
    console.error(`ERROR: xlsx file not found at ${XLSX_PATH}`);
    console.error('Set XLSX_PATH environment variable or place the file in ~/Downloads/');
    process.exit(1);
  }

  console.log('Extracting sheet from xlsx...');
  const xml = extractSheetFromXlsx(XLSX_PATH);
  console.log(`  Extracted ${(xml.length / 1024).toFixed(1)} KB`);

  const rows = parseSheetXml(xml);
  console.log(`  Parsed ${rows.length} rows (including header)`);

  // Skip header (row 1)
  const dataRows = rows.filter(r => r.rowNum > 1);
  const toProcess = LIMIT ? dataRows.slice(0, LIMIT) : dataRows;
  console.log(`  Processing ${toProcess.length} attractions`);
  console.log('');

  // Import Prisma client
  const prisma = require('../utils/prismaClient');

  let created = 0;
  let updated = 0;
  let skipped = 0;
  const errors = [];

  for (const row of toProcess) {
    const c = row.cells;
    const name = (c.A || '').trim();
    const town = (c.B || '').trim() || null;
    const region = (c.C || '').trim() || null;
    const category = (c.D || '').trim() || null;
    const aliases = (c.E || '').trim() || null;
    const history = (c.F || '').trim() || null;

    if (!name) { skipped++; continue; }

    const slug = slugify(name);
    const priority = REGION_PRIORITY[region] || 'Standard';
    // Compare the town's HEAD segment, not the whole string: the town column
    // mixes qualifiers ("Lakeside Estate, Accra", "Kakum / near Cape Coast"), so
    // a plain `includes(capital)` labelled anything in Accra a "Major City".
    const townHead = String(town || '').split(/[,/]/)[0].replace(/^near\s+/i, '').trim().toLowerCase();
    const capital = REGION_CAPITALS[region] ? REGION_CAPITALS[region].toLowerCase() : null;
    const placeType = capital && townHead === capital ? 'Major City' : 'Town';

    try {
      const existing = await prisma.attraction.findUnique({ where: { name }, select: { id: true, town: true } });

      if (existing) {
        // Update existing attraction with new fields
        if (!DRY_RUN) {
          await prisma.attraction.update({
            where: { name },
            data: { town, region, category, aliases, priority, placeType },
          });
        }
        updated++;
        if (updated % 50 === 0) console.log(`  Updated ${updated}...`);
      } else {
        // Create new attraction
        if (!DRY_RUN) {
          await prisma.attraction.create({
            data: {
              name,
              slug,
              town,
              region,
              category,
              aliases,
              priority,
              placeType,
              status: 'ACTIVE',
            },
          });
        }
        created++;
        if (created % 50 === 0) console.log(`  Created ${created}...`);
      }
    } catch (err) {
      errors.push({ name, error: err.message });
    }
  }

  console.log('');
  console.log('=== Results ===');
  console.log(`  Created:  ${created}`);
  console.log(`  Updated:  ${updated}`);
  console.log(`  Skipped:  ${skipped}`);
  if (errors.length) {
    console.log(`  Errors:   ${errors.length}`);
    errors.forEach(e => console.log(`    - ${e.name}: ${e.error}`));
  }
  console.log('');
  console.log('Done.');

  await prisma.$disconnect();
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
