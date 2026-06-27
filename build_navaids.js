const fs = require('fs');

(async () => {
  const r = await fetch('https://davidmegginson.github.io/ourairports-data/navaids.csv');
  const csv = await r.text();
  const lines = csv.split('\n');

  const navaids = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    // Simple CSV parse — split by comma but respect quotes
    const fields = [];
    let cur = '', inQ = false;
    for (let c = 0; c < line.length; c++) {
      if (line[c] === '"') { inQ = !inQ; continue; }
      if (line[c] === ',' && !inQ) { fields.push(cur); cur = ''; continue; }
      cur += line[c];
    }
    fields.push(cur);

    const ident = fields[2];
    const name = fields[3];
    const type = fields[4];
    const freq = fields[5];
    const lat = parseFloat(fields[6]);
    const lon = parseFloat(fields[7]);
    const country = fields[9];

    if (!ident || isNaN(lat) || isNaN(lon)) continue;
    navaids.push({
      id: ident,
      n: name,
      t: type,
      f: freq ? parseInt(freq) : null,
      lat: Math.round(lat * 10000) / 10000,
      lon: Math.round(lon * 10000) / 10000,
      cc: country,
    });
  }

  console.log('Total navaids parsed:', navaids.length);
  const types = [...new Set(navaids.map(n => n.t))];
  console.log('Types:', types.join(', '));

  fs.writeFileSync('web/navaids.json', JSON.stringify(navaids));
  const sz = (fs.statSync('web/navaids.json').size / 1024).toFixed(0);
  console.log(`Saved to web/navaids.json (${sz} KB)`);

  const il = navaids.filter(n => n.cc === 'IL');
  console.log(`\nIsrael navaids (${il.length}):`);
  il.forEach(n => console.log(`  ${n.id}  ${n.t}  ${n.n}  ${n.lat},${n.lon}`));
})();
