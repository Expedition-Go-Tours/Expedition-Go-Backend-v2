const fs = require('fs');

const summaryPath = process.argv[2] || 'k6-output/summary.json';
const outputPath = process.argv[3] || 'k6-output/summary.html';

if (!fs.existsSync(summaryPath)) {
  console.error('summary.json not found at', summaryPath);
  process.exit(0);
}

const data = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
const metrics = data.metrics || {};

const metricRows = Object.entries(metrics).map(([key, val]) => {
  const vals = val.values || {};
  const type = val.type || 'unknown';
  const pcts = Object.entries(vals)
    .filter(([k]) => k.startsWith('p('))
    .map(([k, v]) => `<span class="pct">${k}: <strong>${typeof v === 'number' ? v.toFixed(2) : v}</strong></span>`)
    .join(' ');
  return `<tr>
    <td><code>${key}</code></td>
    <td>${type}</td>
    <td>${vals.avg?.toFixed(2) ?? '-'}</td>
    <td>${vals.min?.toFixed(2) ?? '-'}</td>
    <td>${vals.max?.toFixed(2) ?? '-'}</td>
    <td>${vals.count ?? '-'}</td>
    <td>${pcts}</td>
  </tr>`;
}).join('\n    ');

const pass = data.state?.passed ? '✅ PASSED' : '❌ FAILED';

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>k6 Performance Summary</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 20px; background: #f6f8fa; }
  h1 { color: #24292f; }
  table { border-collapse: collapse; width: 100%; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
  th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #e1e4e8; }
  th { background: #f6f8fa; font-weight: 600; }
  .pct { display: inline-block; margin: 2px 4px 2px 0; background: #ddf4ff; padding: 2px 6px; border-radius: 3px; font-size: 12px; }
  .pass { color: #1a7f37; font-weight: bold; }
  .fail { color: #cf222e; font-weight: bold; }
  .summary { margin: 20px 0; padding: 12px; border-radius: 6px; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
  code { font-family: 'SFMono-Regular', Consolas, monospace; }
</style>
</head>
<body>
<h1>k6 Performance Summary <span class="${data.state?.passed ? 'pass' : 'fail'}">${pass}</span></h1>
<div class="summary">
  <strong>Scenario:</strong> ${data.scenario ?? 'unknown'}<br>
  <strong>Checks:</strong> ${data.state?.checks?.passed ?? 0} passed / ${data.state?.checks?.failed ?? 0} failed<br>
  <strong>Duration:</strong> ${(metrics.http_req_duration?.values?.avg ?? 0).toFixed(2)}ms avg
</div>
<table>
  <thead><tr><th>Metric</th><th>Type</th><th>Avg</th><th>Min</th><th>Max</th><th>Count</th><th>Percentiles</th></tr></thead>
  <tbody>${metricRows}</tbody>
</table>
</body>
</html>`;

fs.writeFileSync(outputPath, html, 'utf8');
console.log(`HTML summary written to ${outputPath}`);
