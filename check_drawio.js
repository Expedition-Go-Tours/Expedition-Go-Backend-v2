const fs = require('fs');
const xml = fs.readFileSync('architecture.drawio', 'utf8');

// All edges already have style attributes, but let me verify the XML is well-formed by checking a few things:
const lines = xml.split('\n');

// Check for any line that has incomplete tags
for (let i = 0; i < lines.length; i++) {
  const line = lines[i].trim();
  // Check for <mxGeometry without />
  if (line.includes('<mxGeometry') && !line.includes('/>') && !line.includes('</mxGeometry')) {
    console.log('ERROR Line', i+1, ': mxGeometry not closed:', line.substring(0, 80));
  }
}

console.log('Validation complete');
