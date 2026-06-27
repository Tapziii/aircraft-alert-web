const fs = require('fs');

const FIX_FILE = 'D:\\SteamLibrary\\steamapps\\common\\X-Plane 12\\Resources\\default data\\earth_fix.dat';
const NAV_FILE = 'D:\\SteamLibrary\\steamapps\\common\\X-Plane 12\\Resources\\default data\\earth_nav.dat';
const OUT_FILE = 'web/waypoints.json';

const waypoints = [];
const seen = new Set(); // dedup by "id|lat|lon"

// ── Parse earth_fix.dat ──
// Format: lat lon ident type region ...
const fixLines = fs.readFileSync(FIX_FILE, 'utf8').split('\n');
let fixCount = 0;
for (const line of fixLines) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('I') || trimmed.startsWith('1200') || trimmed === '99') continue;

  const parts = trimmed.split(/\s+/);
  if (parts.length < 3) continue;

  const lat = parseFloat(parts[0]);
  const lon = parseFloat(parts[1]);
  const id = parts[2];

  if (isNaN(lat) || isNaN(lon) || !id) continue;

  const key = `${id}|${lat.toFixed(4)}|${lon.toFixed(4)}`;
  if (seen.has(key)) continue;
  seen.add(key);

  waypoints.push({ id, lat, lon, t: 'FIX' });
  fixCount++;
}
console.log(`Parsed ${fixCount} fixes from earth_fix.dat`);

// ── Parse earth_nav.dat ──
// Format: type lat lon elev freq range var ident type region name...
// Types: 2=NDB, 3=VOR, 12=DME, 13=TACAN
const NAV_TYPES = { '2': 'NDB', '3': 'VOR', '12': 'DME', '13': 'TACAN' };
const navLines = fs.readFileSync(NAV_FILE, 'utf8').split('\n');
let navCount = 0;
for (const line of navLines) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('I') || trimmed.startsWith('1200') || trimmed === '99') continue;

  const parts = trimmed.split(/\s+/);
  if (parts.length < 8) continue;

  const typeCode = parts[0];
  const navType = NAV_TYPES[typeCode];
  if (!navType) continue; // Skip ILS, GS, markers, etc.

  const lat = parseFloat(parts[1]);
  const lon = parseFloat(parts[2]);
  const freq = parseInt(parts[4]);
  const id = parts[7];
  // Name is everything after the region code (parts[10+])
  const name = parts.slice(10).join(' ');

  if (isNaN(lat) || isNaN(lon) || !id) continue;

  const key = `${id}|${lat.toFixed(4)}|${lon.toFixed(4)}`;
  if (seen.has(key)) continue;
  seen.add(key);

  const entry = { id, lat, lon, t: navType };
  // Add frequency for VOR/NDB
  if (navType === 'VOR' || navType === 'TACAN') {
    entry.freq = (freq / 100).toFixed(2); // stored as 11630 -> 116.30
  } else if (navType === 'NDB') {
    entry.freq = freq.toString(); // NDB freq in kHz, stored directly
  }
  if (name) entry.name = name;

  waypoints.push(entry);
  navCount++;
}
console.log(`Parsed ${navCount} navaids from earth_nav.dat`);

console.log(`Total: ${waypoints.length} waypoints`);

// Verify Israeli waypoints
const check = ['ORLEV','TAPUZ','GEMDA','ASSIF','GODED','VETEK','SOREK','GESEM','DOROT','AMRAM','SIREN'];
check.forEach(id => {
  const matches = waypoints.filter(w => w.id === id && w.lat > 29 && w.lat < 34);
  if (matches.length > 0) {
    matches.forEach(m => console.log(`  ✓ ${id}: ${m.lat.toFixed(6)}, ${m.lon.toFixed(6)}`));
  } else {
    console.log(`  ✗ ${id} NOT FOUND in Israel region`);
  }
});

// Write output
fs.writeFileSync(OUT_FILE, JSON.stringify(waypoints));
const sizeMB = (fs.statSync(OUT_FILE).size / 1024 / 1024).toFixed(1);
console.log(`\nSaved: ${OUT_FILE} (${sizeMB} MB)`);
