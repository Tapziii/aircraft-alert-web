import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'fs';

const buf = new Uint8Array(fs.readFileSync('_aip_enr6.pdf'));
const doc = await getDocument({ data: buf }).promise;

let fullText = '';
for (let i = 1; i <= doc.numPages; i++) {
  const page = await doc.getPage(i);
  const content = await page.getTextContent();
  const text = content.items.map(item => item.str).join(' ');
  fullText += text + '\n';
}

// The AIP text flow is: [coords] NAME [coords] NAME ...
// So coordinates BEFORE a name belong to that name.
// Pattern: DD°MM\u2019SS\u201DN DDD°MM\u2019SS\u201DE  NAME
// OR:      DDD°MM\u2019SS\u201DE DD°MM\u2019SS\u201DN  NAME

const waypoints = [];
const seen = new Set();

// Pattern: lat N lon E then NAME
const r1 = /(\d{2})\s*\u00B0\s*(\d{2})\s*\u2019\s*([\d.]+)\s*\u201D\s*N\s+(\d{2,3})\s*\u00B0\s*(\d{2})\s*\u2019\s*([\d.]+)\s*\u201D\s*E\s+([A-Z]{5})\b/g;
let m;
while ((m = r1.exec(fullText)) !== null) {
  const lat = parseInt(m[1]) + parseInt(m[2]) / 60 + parseFloat(m[3]) / 3600;
  const lon = parseInt(m[4]) + parseInt(m[5]) / 60 + parseFloat(m[6]) / 3600;
  const name = m[7];
  if (seen.has(name)) continue;
  if (lat > 28 && lat < 35 && lon > 33 && lon < 37) {
    seen.add(name);
    waypoints.push({ id: name, lat: Math.round(lat * 10000) / 10000, lon: Math.round(lon * 10000) / 10000 });
  }
}

// Pattern: lon E lat N then NAME
const r2 = /(\d{2,3})\s*\u00B0\s*(\d{2})\s*\u2019\s*([\d.]+)\s*\u201D\s*E\s+(\d{2})\s*\u00B0\s*(\d{2})\s*\u2019\s*([\d.]+)\s*\u201D\s*N\s+([A-Z]{5})\b/g;
while ((m = r2.exec(fullText)) !== null) {
  const lon = parseInt(m[1]) + parseInt(m[2]) / 60 + parseFloat(m[3]) / 3600;
  const lat = parseInt(m[4]) + parseInt(m[5]) / 60 + parseFloat(m[6]) / 3600;
  const name = m[7];
  if (seen.has(name)) continue;
  if (lat > 28 && lat < 35 && lon > 33 && lon < 37) {
    seen.add(name);
    waypoints.push({ id: name, lat: Math.round(lat * 10000) / 10000, lon: Math.round(lon * 10000) / 10000 });
  }
}

console.log(`Parsed ${waypoints.length} waypoints from Israel AIP ENR 6.1:`);
waypoints.sort((a, b) => a.id.localeCompare(b.id));
waypoints.forEach(w => console.log(`  ${w.id.padEnd(8)} ${w.lat},${w.lon}`));

// Load existing
const existing = JSON.parse(fs.readFileSync('web/waypoints.json', 'utf8'));
const existingIds = new Set(existing.filter(w => w.lat > 28 && w.lat < 35 && w.lon > 33 && w.lon < 37).map(w => w.id));

const missing = waypoints.filter(w => !existingIds.has(w.id));
console.log(`\n=== MISSING from DB (${missing.length}): ===`);
missing.forEach(w => console.log(`  ${w.id.padEnd(8)} ${w.lat},${w.lon}`));

for (const w of missing) {
  existing.push({ id: w.id, lat: w.lat, lon: w.lon, t: 'FIX' });
}

// Check for corrections (only if significantly different)
let corrected = 0;
for (const w of waypoints) {
  if (missing.find(m2 => m2.id === w.id)) continue;
  const ex = existing.find(e => e.id === w.id && e.t === 'FIX' && e.lat > 28 && e.lat < 35);
  if (ex && (Math.abs(ex.lat - w.lat) > 0.005 || Math.abs(ex.lon - w.lon) > 0.005)) {
    console.log(`  CORRECTED ${w.id}: ${ex.lat},${ex.lon} → ${w.lat},${w.lon}`);
    ex.lat = w.lat;
    ex.lon = w.lon;
    corrected++;
  }
}

if (missing.length > 0 || corrected > 0) {
  fs.writeFileSync('web/waypoints.json', JSON.stringify(existing));
  console.log(`\nAdded ${missing.length}, corrected ${corrected}. Total: ${existing.length}`);
} else {
  console.log('\nAll AIP waypoints already present.');
}
