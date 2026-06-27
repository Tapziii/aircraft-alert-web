const fs = require('fs');

// Learn waypoints from FlightPlanDatabase.com routes
// Queries common routes to/from Israel and extracts waypoint coordinates

const AIRPORTS = ['LLBG', 'LLRD', 'LLOV', 'LLER', 'LLJR'];
const DEST_AIRPORTS = [
  'EGLL','LFPG','EDDF','EHAM','LTFM','LTBA','LGAV','LROP','LEMD','LIRF',
  'KJFK','KLAX','ZBAA','OMDB','OERK','HECA','LIRA','LFPO','LIMC','LOWW',
  'LSZH','EKCH','ESSA','ENGM','EFHK','LEBL','LPPT','EPWA','LKPR','LHBP',
  'UUEE','UBBB','UDYZ','LTAI','LTFJ','LTAC','LCLK','LCPH','LGTS','LGKO',
];

(async () => {
  const existing = JSON.parse(fs.readFileSync('web/waypoints.json', 'utf8'));
  const existingMap = new Map();
  existing.forEach(w => {
    const key = w.id;
    if (!existingMap.has(key)) existingMap.set(key, []);
    existingMap.get(key).push(w);
  });
  
  let totalPlans = 0;
  let newWaypoints = 0;
  let correctedWaypoints = 0;
  const discovered = new Map(); // id -> {lat, lon, count}
  
  // Search for flight plans
  for (const from of AIRPORTS) {
    for (const to of DEST_AIRPORTS) {
      try {
        const searchUrl = `https://api.flightplandatabase.com/search/plans?fromICAO=${from}&toICAO=${to}&limit=2`;
        const searchRes = await fetch(searchUrl, {
          headers: { 'Accept': 'application/json' },
          signal: AbortSignal.timeout(5000),
        });
        if (!searchRes.ok) continue;
        const plans = await searchRes.json();
        if (!Array.isArray(plans) || plans.length === 0) continue;
        
        // Get full plan details for first result
        for (const plan of plans.slice(0, 1)) {
          try {
            const planRes = await fetch(`https://api.flightplandatabase.com/plan/${plan.id}`, {
              headers: { 'Accept': 'application/json' },
              signal: AbortSignal.timeout(5000),
            });
            if (!planRes.ok) continue;
            const fullPlan = await planRes.json();
            const nodes = fullPlan.route?.nodes;
            if (!nodes) continue;
            
            totalPlans++;
            for (const node of nodes) {
              if (!node.ident || !node.lat || !node.lon) continue;
              if (node.type === 'APT') continue; // Skip airports
              
              const id = node.ident;
              if (discovered.has(id)) {
                const d = discovered.get(id);
                // Average coordinates for better accuracy
                d.lat = (d.lat * d.count + node.lat) / (d.count + 1);
                d.lon = (d.lon * d.count + node.lon) / (d.count + 1);
                d.count++;
              } else {
                discovered.set(id, {
                  lat: node.lat,
                  lon: node.lon,
                  count: 1,
                  type: node.type || 'FIX',
                });
              }
            }
          } catch (e) {}
          await new Promise(r => setTimeout(r, 100)); // Rate limit
        }
      } catch (e) {}
      await new Promise(r => setTimeout(r, 100));
    }
    process.stdout.write(`${from} done (${discovered.size} unique waypoints so far)\n`);
  }
  
  // Also search reverse routes (to Israel)
  for (const to of AIRPORTS) {
    for (const from of DEST_AIRPORTS.slice(0, 15)) {
      try {
        const searchUrl = `https://api.flightplandatabase.com/search/plans?fromICAO=${from}&toICAO=${to}&limit=1`;
        const searchRes = await fetch(searchUrl, {
          headers: { 'Accept': 'application/json' },
          signal: AbortSignal.timeout(5000),
        });
        if (!searchRes.ok) continue;
        const plans = await searchRes.json();
        if (!Array.isArray(plans) || plans.length === 0) continue;
        
        for (const plan of plans.slice(0, 1)) {
          try {
            const planRes = await fetch(`https://api.flightplandatabase.com/plan/${plan.id}`, {
              headers: { 'Accept': 'application/json' },
              signal: AbortSignal.timeout(5000),
            });
            if (!planRes.ok) continue;
            const fullPlan = await planRes.json();
            const nodes = fullPlan.route?.nodes;
            if (!nodes) continue;
            
            totalPlans++;
            for (const node of nodes) {
              if (!node.ident || !node.lat || !node.lon) continue;
              if (node.type === 'APT') continue;
              
              const id = node.ident;
              if (discovered.has(id)) {
                const d = discovered.get(id);
                d.lat = (d.lat * d.count + node.lat) / (d.count + 1);
                d.lon = (d.lon * d.count + node.lon) / (d.count + 1);
                d.count++;
              } else {
                discovered.set(id, { lat: node.lat, lon: node.lon, count: 1, type: node.type || 'FIX' });
              }
            }
          } catch (e) {}
          await new Promise(r => setTimeout(r, 100));
        }
      } catch (e) {}
      await new Promise(r => setTimeout(r, 100));
    }
  }
  
  console.log(`\nProcessed ${totalPlans} flight plans`);
  console.log(`Discovered ${discovered.size} unique waypoints`);
  
  // Find missing waypoints
  const missing = [];
  for (const [id, data] of discovered) {
    const entries = existingMap.get(id);
    if (!entries || entries.length === 0) {
      missing.push({
        id,
        lat: Math.round(data.lat * 10000) / 10000,
        lon: Math.round(data.lon * 10000) / 10000,
        t: data.type === 'VOR' ? 'VOR' : data.type === 'NDB' ? 'NDB' : 'FIX',
      });
    }
  }
  
  console.log(`\n=== NEW waypoints from flight plans (${missing.length}): ===`);
  missing.sort((a, b) => a.id.localeCompare(b.id));
  // Show Israel-region ones first
  const ilMissing = missing.filter(w => w.lat > 28 && w.lat < 35 && w.lon > 33 && w.lon < 37);
  console.log(`\nIsrael region (${ilMissing.length}):`);
  ilMissing.forEach(w => console.log(`  ${w.id.padEnd(8)} ${w.lat},${w.lon}`));
  
  console.log(`\nGlobal (${missing.length - ilMissing.length} more)`);
  
  // Add all missing
  for (const w of missing) {
    existing.push(w);
    newWaypoints++;
  }
  
  if (newWaypoints > 0) {
    fs.writeFileSync('web/waypoints.json', JSON.stringify(existing));
    const sz = (fs.statSync('web/waypoints.json').size / 1024).toFixed(0);
    console.log(`\nAdded ${newWaypoints}. Total: ${existing.length} (${sz} KB)`);
  } else {
    console.log('\nNo new waypoints to add.');
  }
})();
