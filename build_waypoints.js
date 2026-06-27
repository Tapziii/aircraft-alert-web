const fs = require('fs');

// Build waypoints from X-Plane earth_fix.dat (comprehensive global source)
// Then merge with existing navaids

(async () => {
  console.log('Downloading earth_fix.dat...');
  const r = await fetch('https://raw.githubusercontent.com/mcantsin/x-plane-navdata/master/earth_fix.dat', {
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) { console.error('Failed:', r.status); return; }
  const text = await r.text();
  const lines = text.split('\n');
  console.log(`Downloaded ${lines.length} lines`);

  const fixes = [];
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const lat = parseFloat(parts[0]);
    const lon = parseFloat(parts[1]);
    const id = parts[2];
    if (isNaN(lat) || isNaN(lon) || !id || id.length < 2) continue;
    // Skip header/footer lines
    if (id === 'I' || id === '99') continue;
    fixes.push({
      id,
      lat: Math.round(lat * 10000) / 10000,
      lon: Math.round(lon * 10000) / 10000,
      t: 'FIX',
    });
  }
  console.log(`Parsed ${fixes.length} fixes from X-Plane data`);

  // Deduplicate — X-Plane can have same fix name in multiple regions
  // Keep all, but use a composite key of id+region to avoid true duplicates
  const seen = new Map(); // id -> [{lat,lon}]
  const unique = [];
  for (const f of fixes) {
    const key = f.id;
    if (!seen.has(key)) {
      seen.set(key, []);
    }
    // Check if this is a duplicate position (within 0.01 deg)
    const existing = seen.get(key);
    const isDup = existing.some(e => Math.abs(e.lat - f.lat) < 0.01 && Math.abs(e.lon - f.lon) < 0.01);
    if (!isDup) {
      existing.push({ lat: f.lat, lon: f.lon });
      unique.push(f);
    }
  }
  console.log(`Unique fixes: ${unique.length}`);

  // Now merge with navaids
  const usedIds = new Set(unique.map(f => f.id + '_' + f.lat + '_' + f.lon));
  if (fs.existsSync('web/navaids.json')) {
    const navaids = JSON.parse(fs.readFileSync('web/navaids.json', 'utf8'));
    let navCount = 0;
    for (const nav of navaids) {
      const key = nav.id + '_' + nav.lat + '_' + nav.lon;
      if (!usedIds.has(key)) {
        usedIds.add(key);
        unique.push({ id: nav.id, lat: nav.lat, lon: nav.lon, t: nav.t, n: nav.n, f: nav.f });
        navCount++;
      }
    }
    console.log(`Added ${navCount} navaids`);
  }

  // Type distribution
  const types = {};
  unique.forEach(w => { types[w.t] = (types[w.t] || 0) + 1; });
  console.log('Types:', JSON.stringify(types));
  console.log(`Total: ${unique.length}`);

  fs.writeFileSync('web/waypoints.json', JSON.stringify(unique));
  const sz = (fs.statSync('web/waypoints.json').size / 1024).toFixed(0);
  console.log(`Saved to web/waypoints.json (${sz} KB)`);

  // Israel check
  const il = unique.filter(w => w.t === 'FIX' && w.lat > 29 && w.lat < 34 && w.lon > 34 && w.lon < 36);
  console.log(`\nIsrael FIX waypoints: ${il.length}`);
  il.sort((a, b) => a.id.localeCompare(b.id));
  il.forEach(w => console.log(`  ${w.id.padEnd(8)} ${w.lat},${w.lon}`));

  // Verify known waypoints
  console.log('\n--- Verification ---');
  ['GODED','DOROT','SHIRA','LATOV','SOREK','TAVOR','CARML','MODYN','BALMA','AMMIT','DESHE'].forEach(n => {
    const matches = unique.filter(w => w.id === n);
    if (matches.length > 0) {
      matches.forEach(m => console.log(`  ${n}: ${m.lat},${m.lon}`));
    } else {
      console.log(`  ${n}: MISSING`);
    }
  });
})();
