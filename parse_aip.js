const fs = require('fs');

// Crude PDF text extraction — find text strings between parentheses in the PDF stream
const buf = fs.readFileSync('_aip_enr6.pdf');
const text = buf.toString('latin1');

// Extract all text between parentheses (PDF text objects)
const textParts = [];
const regex = /\(([^)]{1,200})\)/g;
let m;
while ((m = regex.exec(text)) !== null) {
  const s = m[1].replace(/\\n/g, '\n').replace(/\\\\/g, '\\').replace(/\\([()])/g, '$1');
  if (s.trim().length > 0) textParts.push(s);
}

const fullText = textParts.join(' ');
fs.writeFileSync('_aip_text.txt', fullText);
console.log('Extracted text parts:', textParts.length, 'Total chars:', fullText.length);

// Look for 5-letter waypoint names
const wpNames = new Set();
const nameRegex = /\b([A-Z]{5})\b/g;
while ((m = nameRegex.exec(fullText)) !== null) {
  wpNames.add(m[1]);
}

// Filter to likely aviation waypoints (not common English words)
const commonWords = new Set(['ABOUT','ABOVE','AFTER','AGAIN','ALONG','AMONG','BASED','BELOW','BOUND',
  'BRIEF','CHART','CHECK','CIVIL','CLASS','CLEAR','CLOSE','CODES','COULD','COVER','CROSS','DATUM',
  'DEPTH','DRAFT','ENTRY','EVERY','EXACT','EXTRA','FIRST','FIXED','FLOOR','FOUND','GIVEN','GRANT',
  'GREEN','GUARD','GUIDE','HOURS','ICAON','LEVEL','LIGHT','LIMIT','LINES','LOWER','MIGHT','MILES',
  'NORTH','NOTED','OCCUR','OFFER','ORDER','OTHER','OUTER','PARTS','PHASE','PILOT','PLACE','PLANE',
  'POINT','POWER','PRIOR','PROOF','RADAR','RADIO','RANGE','RATIO','REACH','RIGHT','ROUTE','RULES',
  'SHALL','SHARE','SHIFT','SHORT','SHOWN','SINCE','SITES','SOUTH','SPACE','SPEED','START','STATE',
  'STILL','STORM','STRIP','TABLE','TAKEN','THEIR','THERE','THESE','THREE','TIMES','TITLE','TOTAL',
  'TOWER','TRACK','TRAIN','TRIAL','TWICE','UNDER','UNITS','UNTIL','UPPER','USAGE','VALID','VALUE',
  'WATER','WHEEL','WHERE','WHICH','WHILE','WHITE','WIDTH','WORLD','WOULD','YEARS',
  'ABOVE','AMEND','APPLY','AREAS','BLOCK','BOARD','CLIMB','COAST','DATUM','DELAY','DELTA',
  'ENROUTE','ERROR','EVENT','FINAL','GREAT','HEAVY','IDENT','ISSUE','KNOWN','LARGE','MAJOR',
  'MEANS','MEDIA','MINOR','NEVER','NOTES','PAGES','SMALL','STAND','THOSE','TRANS','USING',
  'VOICE','WINDS','ALPHA','BRAVO','INDIA','TANGO',
]);

const candidates = [...wpNames].filter(n => !commonWords.has(n));
console.log('\nCandidate waypoint names:', candidates.length);

// Now look for coordinates near each name
const waypoints = [];
const seen = new Set();

// Search for patterns like: NAME ... 31 25 30 N 035 00 16 E  or  312530N 0350016E
for (const name of candidates) {
  const nameIdx = fullText.indexOf(name);
  if (nameIdx < 0) continue;
  // Look at the 200 chars after the name
  const after = fullText.substring(nameIdx, nameIdx + 300);
  
  // Try: DD MM SS.SS N DDD MM SS.SS E
  const coordMatch = after.match(/(\d{2})\s*(\d{2})\s*([\d.]+)\s*N\s*(\d{2,3})\s*(\d{2})\s*([\d.]+)\s*E/);
  if (coordMatch) {
    const lat = parseInt(coordMatch[1]) + parseInt(coordMatch[2]) / 60 + parseFloat(coordMatch[3]) / 3600;
    const lon = parseInt(coordMatch[4]) + parseInt(coordMatch[5]) / 60 + parseFloat(coordMatch[6]) / 3600;
    if (lat > 28 && lat < 35 && lon > 33 && lon < 37 && !seen.has(name)) {
      seen.add(name);
      waypoints.push({ id: name, lat: Math.round(lat * 10000) / 10000, lon: Math.round(lon * 10000) / 10000 });
    }
  }
}

console.log(`\nParsed ${waypoints.length} waypoints from AIP:`);
waypoints.sort((a, b) => a.id.localeCompare(b.id));
waypoints.forEach(w => console.log(`  ${w.id.padEnd(8)} ${w.lat},${w.lon}`));

// Find missing
const existing = JSON.parse(fs.readFileSync('web/waypoints.json', 'utf8'));
const existingIds = new Set(existing.filter(w => w.lat > 28 && w.lat < 35).map(w => w.id));

const missing = waypoints.filter(w => !existingIds.has(w.id));
console.log(`\n=== MISSING (${missing.length}): ===`);
missing.forEach(w => console.log(`  ${w.id.padEnd(8)} ${w.lat},${w.lon}`));

// Add missing
for (const w of missing) {
  existing.push({ id: w.id, lat: w.lat, lon: w.lon, t: 'FIX' });
}
if (missing.length > 0) {
  fs.writeFileSync('web/waypoints.json', JSON.stringify(existing));
  console.log(`\nAdded ${missing.length}. Total: ${existing.length}`);
}
