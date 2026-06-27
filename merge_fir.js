const fs = require('fs');
const polygonClipping = require('polygon-clipping');

const COUNTRY_NAMES = {
  'AG':'Solomon Is.','AN':'Nauru','AY':'Papua New Guinea',
  'BG':'Greenland','BI':'Iceland','BK':'Kosovo',
  'DA':'Algeria','DB':'Benin','DF':'Burkina Faso','DG':'Ghana',
  'DI':'Côte d\'Ivoire','DN':'Nigeria','DR':'Niger','DT':'Tunisia','DX':'Togo',
  'EB':'Belgium','ED':'Germany','EE':'Estonia','EF':'Finland','EG':'United Kingdom',
  'EH':'Netherlands','EI':'Ireland','EK':'Denmark','EL':'Luxembourg',
  'EN':'Norway','EP':'Poland','ES':'Sweden','ET':'Germany (mil)',
  'EV':'Latvia','EY':'Lithuania',
  'FA':'South Africa','FB':'Botswana','FC':'Congo','FD':'Swaziland',
  'FE':'Central Africa','FG':'Eq. Guinea','FH':'Ascension',
  'FI':'Mauritius','FJ':'Chagos','FK':'Cameroon',
  'FL':'Zambia','FM':'Madagascar','FN':'Angola','FO':'Gabon',
  'FQ':'Mozambique','FS':'Seychelles','FT':'Chad',
  'FV':'Zimbabwe','FW':'Malawi','FX':'Lesotho','FY':'Namibia','FZ':'DR Congo',
  'GA':'Mali','GB':'Gambia','GC':'Canary Is.','GE':'Spain (Ceuta)','GF':'Sierra Leone',
  'GG':'Guinea-Bissau','GL':'Liberia','GM':'Morocco','GO':'Senegal',
  'GQ':'Mauritania','GS':'Western Sahara','GU':'Guinea','GV':'Cape Verde',
  'HA':'Ethiopia','HB':'Burundi','HC':'Somalia','HD':'Djibouti',
  'HE':'Egypt','HF':'Djibouti','HH':'Eritrea',
  'HK':'Kenya','HL':'Libya','HR':'Rwanda',
  'HS':'Sudan','HT':'Tanzania','HU':'Uganda',
  'LA':'Albania','LB':'Bulgaria','LC':'Cyprus','LD':'Croatia',
  'LE':'Spain','LF':'France','LG':'Greece','LH':'Hungary',
  'LI':'Italy','LJ':'Slovenia','LK':'Czech Republic','LL':'Israel',
  'LM':'Malta','LN':'Monaco','LO':'Austria','LP':'Portugal',
  'LQ':'Bosnia & Herz.','LR':'Romania','LS':'Switzerland',
  'LT':'Turkey','LU':'Moldova','LV':'Palestine','LW':'N. Macedonia',
  'LX':'Gibraltar','LY':'Serbia','LZ':'Slovakia',
  'MB':'Turks & Caicos','MD':'Dominican Rep.','MG':'Guatemala',
  'MH':'Honduras','MK':'Jamaica','MM':'Mexico',
  'MN':'Nicaragua','MP':'Panama','MR':'Costa Rica','MS':'El Salvador',
  'MT':'Haiti','MU':'Cuba','MW':'Cayman Is.','MY':'Bahamas','MZ':'Belize',
  'NC':'Cook Is.','NF':'Fiji','NI':'Niue','NL':'Funafuti','NS':'Samoa',
  'NT':'French Polynesia','NV':'Vanuatu','NW':'New Caledonia','NZ':'New Zealand',
  'OA':'Afghanistan','OB':'Bahrain','OE':'Saudi Arabia',
  'OI':'Iran','OJ':'Jordan','OK':'Kuwait','OL':'Lebanon',
  'OM':'UAE','OP':'Pakistan','OR':'Iraq','OS':'Syria','OT':'Qatar','OY':'Yemen',
  'PA':'Alaska','PG':'Guam','PH':'Hawaii','PK':'Marshall Is.',
  'PL':'Kiribati','PM':'Midway','PT':'Micronesia',
  'RC':'Taiwan','RJ':'Japan','RK':'South Korea','RP':'Philippines',
  'SA':'Argentina','SB':'Brazil','SC':'Chile','SE':'Ecuador',
  'SG':'Paraguay','SK':'Colombia','SL':'Bolivia','SM':'Suriname',
  'SO':'French Guiana','SP':'Peru','SU':'Uruguay','SV':'Venezuela','SY':'Guyana',
  'TA':'Antigua','TB':'Barbados','TD':'Dominica','TF':'French Antilles',
  'TG':'Grenada','TI':'US Virgin Is.','TJ':'Puerto Rico',
  'TK':'St. Kitts','TL':'St. Lucia','TN':'Aruba/Curaçao',
  'TQ':'Anguilla','TR':'Montserrat','TT':'Trinidad','TU':'Br. Virgin Is.','TV':'St. Vincent',
  'TX':'Bermuda',
  'UA':'Kazakhstan','UB':'Azerbaijan','UC':'Kyrgyzstan',
  'UD':'Armenia','UE':'Russia (E)','UG':'Georgia',
  'UH':'Russia (Far East)','UI':'Russia (E Siberia)',
  'UK':'Ukraine','UL':'Russia (NW)','UM':'Belarus',
  'UN':'Russia (Novosibirsk)','UO':'Russia','UP':'Russia',
  'UR':'Russia (S)','US':'Russia (Ural)','UT':'Uzbekistan/Tajik.',
  'UU':'Russia (Moscow)','UW':'Russia (Volga)',
  'VA':'India (W)','VC':'Sri Lanka','VD':'Cambodia',
  'VE':'India (E)','VG':'Bangladesh','VH':'Hong Kong',
  'VI':'India (N)','VL':'Laos','VM':'Macau',
  'VN':'Nepal','VO':'India (S)','VQ':'Bhutan',
  'VR':'Maldives','VT':'Thailand','VV':'Vietnam','VY':'Myanmar',
  'WA':'Indonesia','WB':'Malaysia (E)','WI':'Indonesia',
  'WM':'Malaysia (W)','WP':'Timor-Leste','WR':'Indonesia','WS':'Singapore',
  'YB':'Australia','YM':'Australia','YS':'Australia',
  'ZB':'China (N)','ZG':'China (S)','ZH':'China (C)',
  'ZJ':'China (Hainan)','ZK':'North Korea','ZL':'China (NW)',
  'ZM':'Mongolia','ZP':'China (SW)','ZS':'China (E)',
  'ZU':'China (Chengdu)','ZW':'China (Xi\'an)','ZY':'China (Shenyang)',
  'AD':'Andorra','CZ':'Canada','KZ':'United States','TE':'US (Oceanic)',
  'YA':'Australia','YC':'Australia','YE':'Australia','YF':'Australia',
  'YG':'Australia','YH':'Australia','YI':'Australia','YK':'Australia',
  'YN':'Australia','YO':'Australia','YP':'Australia','YT':'Australia','YW':'Australia',
  'UZ':'Uzbekistan',
  'K':'United States','C':'Canada',
};

// Extract all polygon rings from a feature
function toMultiPolyCoords(feature) {
  const g = feature.geometry;
  if (g.type === 'Polygon') return [g.coordinates];
  if (g.type === 'MultiPolygon') return g.coordinates;
  return [];
}

const raw = JSON.parse(fs.readFileSync('_fir_raw.json', 'utf8'));
console.log(`Raw features: ${raw.features.length}`);

// Map prefixes that belong to the same country into a unified key
const UNIFY = {
  // Russia
  'UE':'RU','UH':'RU','UI':'RU','UL':'RU','UN':'RU','UO':'RU',
  'UP':'RU','UR':'RU','US':'RU','UU':'RU','UW':'RU',
  // United States
  'KZ':'US','PA':'US','PH':'US','PG':'US','PK':'US','PL':'US','PM':'US','PT':'US','TE':'US',
  // Australia
  'YA':'AU','YB':'AU','YC':'AU','YE':'AU','YF':'AU','YG':'AU','YH':'AU',
  'YI':'AU','YK':'AU','YM':'AU','YN':'AU','YO':'AU','YP':'AU','YS':'AU','YT':'AU','YW':'AU',
  // China
  'ZB':'CN','ZG':'CN','ZH':'CN','ZJ':'CN','ZL':'CN','ZP':'CN','ZS':'CN','ZU':'CN','ZW':'CN','ZY':'CN',
  // Indonesia
  'WA':'ID','WI':'ID','WR':'ID',
  // India
  'VA':'IN','VE':'IN','VI':'IN','VO':'IN',
  // Canada
  'CZ':'CA',
  // Germany (civil + military)
  'ED':'DE','ET':'DE',
};
const UNIFY_NAMES = {
  'RU':'Russia','US':'United States','AU':'Australia','CN':'China',
  'ID':'Indonesia','IN':'India','CA':'Canada','DE':'Germany',
};

// Group by unified country key
const groups = {};
for (const f of raw.features) {
  const id = f.properties.id || '';
  const prefix = id.substring(0, 2);
  if (!prefix) continue;
  const key = UNIFY[prefix] || prefix;
  if (!groups[key]) groups[key] = [];
  groups[key].push(f);
}
console.log(`Country groups: ${Object.keys(groups).length}`);

const merged = [];
let ok = 0, fail = 0;

for (const [prefix, features] of Object.entries(groups)) {
  // Collect all polygon coordinate arrays
  const allPolys = [];
  for (const f of features) {
    allPolys.push(...toMultiPolyCoords(f));
  }

  if (allPolys.length <= 1) {
    merged.push({
      type: 'Feature',
      properties: { id: prefix, name: UNIFY_NAMES[prefix] || COUNTRY_NAMES[prefix] || prefix },
      geometry: allPolys.length === 1
        ? { type: 'Polygon', coordinates: allPolys[0] }
        : { type: 'MultiPolygon', coordinates: allPolys },
    });
    ok++;
    continue;
  }

  // Use polygon-clipping to union all polygons
  try {
    const result = polygonClipping.union(...allPolys);
    merged.push({
      type: 'Feature',
      properties: { id: prefix, name: UNIFY_NAMES[prefix] || COUNTRY_NAMES[prefix] || prefix },
      geometry: result.length === 1
        ? { type: 'Polygon', coordinates: result[0] }
        : { type: 'MultiPolygon', coordinates: result },
    });
    ok++;
  } catch (e) {
    // Fallback: just keep as MultiPolygon (internal borders will show)
    console.log(`  ⚠ ${prefix} (${UNIFY_NAMES[prefix] || COUNTRY_NAMES[prefix] || '?'}): union failed, keeping ${allPolys.length} polygons`);
    merged.push({
      type: 'Feature',
      properties: { id: prefix, name: UNIFY_NAMES[prefix] || COUNTRY_NAMES[prefix] || prefix },
      geometry: { type: 'MultiPolygon', coordinates: allPolys },
    });
    fail++;
  }
}

console.log(`\nUnion OK: ${ok}, fallback: ${fail}`);
console.log(`Total: ${merged.length} country FIR boundaries`);

const output = { type: 'FeatureCollection', features: merged };
fs.writeFileSync('web/fir_boundaries.json', JSON.stringify(output));
const sz = (fs.statSync('web/fir_boundaries.json').size / 1024).toFixed(0);
console.log(`Saved: ${sz} KB`);

['LL','OJ','OL','LC','HE','LT','EG','LF','LI','ED','EP','ES'].forEach(id => {
  const f = merged.find(m => m.properties.id === id);
  if (f) console.log(`  ✓ ${id} → ${f.properties.name}`);
  else console.log(`  ✗ ${id} MISSING!`);
});
