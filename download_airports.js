(async () => {
  const fs = require('fs');
  const res = await fetch('https://davidmegginson.github.io/ourairports-data/airports.csv');
  const text = await res.text();
  
  const lines = text.split('\n');
  console.log('Total lines:', lines.length);
  console.log('Header:', lines[0].substring(0, 200));
  
  // Parse to JSON: { ICAO: { lat, lon, name } }
  const header = lines[0].split(',').map(h => h.replace(/"/g, ''));
  const iIdent = header.indexOf('ident');
  const iLat = header.indexOf('latitude_deg');
  const iLon = header.indexOf('longitude_deg');
  const iName = header.indexOf('name');
  const iType = header.indexOf('type');
  
  console.log('Column indices:', { iIdent, iLat, iLon, iName, iType });
  
  const db = {};
  let count = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    // Simple CSV parse (handles quoted fields)
    const cols = [];
    let current = '';
    let inQuotes = false;
    for (const ch of line) {
      if (ch === '"') { inQuotes = !inQuotes; continue; }
      if (ch === ',' && !inQuotes) { cols.push(current); current = ''; continue; }
      current += ch;
    }
    cols.push(current);
    
    const ident = cols[iIdent];
    const lat = parseFloat(cols[iLat]);
    const lon = parseFloat(cols[iLon]);
    const name = cols[iName] || '';
    const type = cols[iType] || '';
    
    // Skip heliports and closed airports, keep all others
    if (!ident || isNaN(lat) || isNaN(lon)) continue;
    if (type === 'closed') continue;
    
    db[ident] = { lat, lon, name: name.substring(0, 60) };
    count++;
  }
  
  console.log('Airports parsed:', count);
  console.log('Sample LLBG:', db['LLBG']);
  console.log('Sample KJFK:', db['KJFK']);
  console.log('Sample LGAV:', db['LGAV']);
  console.log('Sample EGLL:', db['EGLL']);
  
  fs.writeFileSync('airports.json', JSON.stringify(db));
  const sizeMB = (fs.statSync('airports.json').size / 1024 / 1024).toFixed(1);
  console.log(`Saved airports.json (${sizeMB} MB)`);
})();
