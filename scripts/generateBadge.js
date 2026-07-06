const fs = require('fs');
const path = require('path');

const summaryPath = path.join(__dirname, '..', 'coverage', 'coverage-summary.json');
const outputPath = path.join(__dirname, '..', 'coverage-badge.svg');

if (!fs.existsSync(summaryPath)) {
  console.error('coverage-summary.json not found at', summaryPath);
  process.exit(0);
}

const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
const total = summary.total;

if (!total) {
  console.error('No total key in coverage summary');
  process.exit(0);
}

const linesPct = total.lines.pct;
const statementsPct = total.statements.pct;
const functionsPct = total.functions.pct;
const branchesPct = total.branches.pct;

const color = (pct) => {
  if (pct >= 90) return 'brightgreen';
  if (pct >= 75) return 'green';
  if (pct >= 60) return 'yellowgreen';
  if (pct >= 50) return 'yellow';
  if (pct >= 40) return 'orange';
  return 'red';
};

const labelColor = '#555';

function badge(left, right, rightColor) {
  const lw = left.length * 7 + 12;
  const rw = right.length * 7 + 12;
  const tw = lw + rw;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${tw}" height="20" role="img" aria-label="${left}: ${right}">
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r">
    <rect width="${tw}" height="20" rx="3" fill="#fff"/>
  </clipPath>
  <g clip-path="url(#r)">
    <rect width="${lw}" height="20" fill="${labelColor}"/>
    <rect x="${lw}" width="${rw}" height="20" fill="${rightColor}"/>
    <rect width="${tw}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="11">
    <text x="${lw / 2}" y="15" fill="#010101" fill-opacity=".3">${left}</text>
    <text x="${lw / 2}" y="14">${left}</text>
    <text x="${lw + rw / 2}" y="15" fill="#010101" fill-opacity=".3">${right}</text>
    <text x="${lw + rw / 2}" y="14">${right}</text>
  </g>
</svg>`;
}

const lines = [
  badge('coverage:lines', `${linesPct}%`, color(linesPct)),
  badge('coverage:statements', `${statementsPct}%`, color(statementsPct)),
  badge('coverage:functions', `${functionsPct}%`, color(functionsPct)),
  badge('coverage:branches', `${branchesPct}%`, color(branchesPct)),
];

const combined = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="92">
  <style>text { font-family: DejaVu Sans,Verdana,Geneva,sans-serif; font-size: 11px; fill: #333; }</style>
  <rect width="720" height="92" fill="#f6f8fa" rx="4"/>
  <text x="10" y="16" font-weight="bold" font-size="13">Coverage Summary</text>
  ${lines.map((svg, i) => {
    const match = svg.match(/width="([\d.]+)"/);
    const w = parseFloat(match[1]);
    const x = 10 + (i % 2) * 180;
    const y = 28 + Math.floor(i / 2) * 30;
    return svg.replace(/svg/, `svg x="${x}" y="${y}"`);
  }).join('\n  ')}
</svg>`;

fs.writeFileSync(outputPath, combined, 'utf8');
console.log(`Badge written to ${outputPath}`);
