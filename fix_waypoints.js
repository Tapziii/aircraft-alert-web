const fs = require('fs');

// Look up missing Israel waypoints from OpenNav individual pages
// Then look up ALL waypoints from OpenNav's comprehensive search

const MISSING = [
  'DOROT','LATOV','SOREK','TAVOR','CARML','MODYN','RUTAM','NATBA',
  'GOREN','DAROM','KEDMA','EMBON','ARNON','OLMER','MAQAR','SHIRA',
  'GAVIM','CEDAR','ELASA','HADAR','LAHAT','SHUVA','TAPUZ','OFIRA',
  'GEZER','ASHER','DELEK','GIDON','HAZOR','HERUT','MEGEV','NATAN',
  'NOAMI','OSHER','PELES','RAVIV','SADOT','SOREQ','TABOR','ZAHAV',
];

function parseDMS(str) {
  const m = str.match(/(\d+)\D+(\d+)\D+([\d.]+)\D*([NSEW])/);
  if (!m) return NaN;
  let deg = parseInt(m[1]) + parseInt(m[2]) / 60 + parseFloat(m[3]) / 3600;
  if (m[4] === 'S' || m[4] === 'W') deg = -deg;
  return Math.round(deg * 10000) / 10000;
}

(async () => {
  // Load existing waypoints
  const existing = JSON.parse(fs.readFileSync('web/waypoints.json', 'utf8'));
  const existingMap = new Map(existing.map(w => [w.id, w]));
  let added = 0;
  let fixed = 0;

  // 1. Look up missing waypoints individually
  for (const wp of MISSING) {
    try {
      // Try multiple country codes
      for (const cc of ['IL', 'JO', 'CY', 'LB', 'SY']) {
        const r = await fetch(`https://opennav.com/waypoint/${cc}/${wp}`, {
          signal: AbortSignal.timeout(5000),
        });
        if (!r.ok) continue;
        const t = await r.text();
        
        const degMatches = [...t.matchAll(/(\d+)\s*\u00b0\s*(\d+)\s*'\s*([\d.]+)\s*"\s*([NSEW])/g)];
        if (degMatches.length >= 2) {
          const lat = parseDMS(degMatches[0][0]);
          const lon = parseDMS(degMatches[1][0]);
          if (!isNaN(lat) && !isNaN(lon)) {
            const inRegion = lat > 28 && lat < 35 && lon > 33 && lon < 37;
            if (inRegion) {
              if (existingMap.has(wp)) {
                const old = existingMap.get(wp);
                if (Math.abs(old.lat - lat) > 0.01 || Math.abs(old.lon - lon) > 0.01) {
                  console.log(`FIXED ${wp}: ${old.lat},${old.lon} → ${lat},${lon}`);
                  old.lat = lat;
                  old.lon = lon;
                  fixed++;
                }
              } else {
                console.log(`ADDED ${wp}: ${lat},${lon}`);
                existing.push({ id: wp, lat, lon, t: 'FIX' });
                existingMap.set(wp, { id: wp, lat, lon, t: 'FIX' });
                added++;
              }
              break;
            }
          }
        }
      }
    } catch (e) {}
    await new Promise(r => setTimeout(r, 150));
  }

  // 2. Also try to scrape more complete list from OpenNav search
  try {
    // Get ALL Israeli waypoints from multiple pages
    for (let page = 1; page <= 5; page++) {
      const r = await fetch(`https://opennav.com/waypoint/IL?page=${page}`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) break;
      const html = await r.text();
      
      const lines = html.split('\n');
      for (const line of lines) {
        const nameMatch = line.match(/waypoint\/\w+\/([A-Z0-9]+)/);
        if (!nameMatch) continue;
        const id = nameMatch[1];
        
        const degMatches = [...line.matchAll(/(\d+)\s*\u00b0\s*(\d+)\s*'\s*([\d.]+)\s*"\s*([NSEW])/g)];
        if (degMatches.length < 2) continue;
        
        const lat = parseDMS(degMatches[0][0]);
        const lon = parseDMS(degMatches[1][0]);
        if (isNaN(lat) || isNaN(lon)) continue;
        
        if (!existingMap.has(id)) {
          existing.push({ id, lat, lon, t: 'FIX' });
          existingMap.set(id, { id, lat, lon, t: 'FIX' });
          added++;
          process.stdout.write(`+${id} `);
        }
      }
      await new Promise(r => setTimeout(r, 200));
    }
  } catch (e) {}

  // 3. Try neighboring countries for shared waypoints
  for (const cc of ['JO', 'CY', 'LB', 'EG']) {
    try {
      for (let page = 1; page <= 3; page++) {
        const r = await fetch(`https://opennav.com/waypoint/${cc}?page=${page}`, {
          signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) break;
        const html = await r.text();
        
        const lines = html.split('\n');
        for (const line of lines) {
          const nameMatch = line.match(/waypoint\/\w+\/([A-Z0-9]+)/);
          if (!nameMatch) continue;
          const id = nameMatch[1];
          
          const degMatches = [...line.matchAll(/(\d+)\s*\u00b0\s*(\d+)\s*'\s*([\d.]+)\s*"\s*([NSEW])/g)];
          if (degMatches.length < 2) continue;
          
          const lat = parseDMS(degMatches[0][0]);
          const lon = parseDMS(degMatches[1][0]);
          if (isNaN(lat) || isNaN(lon)) continue;
          
          if (!existingMap.has(id)) {
            existing.push({ id, lat, lon, t: 'FIX' });
            existingMap.set(id, { id, lat, lon, t: 'FIX' });
            added++;
          }
        }
        await new Promise(r => setTimeout(r, 200));
      }
    } catch (e) {}
  }

  console.log(`\n\nAdded: ${added}, Fixed: ${fixed}`);
  console.log(`Total waypoints: ${existing.length}`);

  fs.writeFileSync('web/waypoints.json', JSON.stringify(existing));
  const sz = (fs.statSync('web/waypoints.json').size / 1024).toFixed(0);
  console.log(`Saved (${sz} KB)`);

  // Verify SHIRA
  const shira = existingMap.get('SHIRA');
  if (shira) console.log(`\nSHIRA: ${shira.lat}, ${shira.lon}`);

  // Check newly found
  const il = [...existingMap.values()].filter(w => w.t === 'FIX' && w.lat > 29 && w.lat < 34 && w.lon > 34 && w.lon < 36);
  console.log(`Israel FIX count: ${il.length}`);
})();
