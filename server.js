require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const atcTranscriber = require('./atc-transcriber');

// Prevent AbortError crashes from ATC stream proxy teardown
process.on('unhandledRejection', (err) => {
  if (err && err.name === 'AbortError') return; // Expected when ATC stream client disconnects
  console.error('Unhandled rejection:', err);
});

const webpush = require('web-push');
const { MongoClient } = require('mongodb');

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    'mailto:admin@aircraftalert.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

let db = null;
if (process.env.MONGO_URI) {
  const client = new MongoClient(process.env.MONGO_URI);
  client.connect()
    .then(c => {
      db = c.db('aircraftAlert');
      console.log('✅ Connected to MongoDB for push notifications');
    })
    .catch(e => console.error('❌ MongoDB connection error:', e.message));
}

// ── Config ──
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const POLL_INTERVAL = (parseInt(process.env.POLL_INTERVAL) || 5) * 1000;
const PORT = parseInt(process.env.PORT) || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const AVIATIONSTACK_KEY = process.env.AVIATIONSTACK_KEY || 'e36095542d0605cb445eadd7c2204673';
const WEB_DIR = path.join(__dirname, 'web');

if (!BOT_TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN not set. Copy .env.example to .env and add your token.');
  process.exit(1);
}

// ── Persistence ──
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      return JSON.parse(raw);
    }
  } catch (e) {
    console.error('Failed to load data.json:', e.message);
  }
  return {};
}

function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify({
      watchlist,
      chatId: CHAT_ID,
      routeCache,
      telegramOffset,
      telegramEnabled,
      geofence: {
        enabled: geofence.enabled,
        lat: geofence.lat,
        lon: geofence.lon,
        radiusNm: geofence.radiusNm,
      },
      removedIcaos: [...removedIcaos],
      favoriteAirports,
      lastSeenMap,
    }, null, 2));
  } catch (e) {
    console.error('Failed to save data.json:', e.message);
  }
}

// ── State (loaded from disk) ──
const saved = loadData();
let watchlist = saved.watchlist || [];
let CHAT_ID = saved.chatId || process.env.TELEGRAM_CHAT_ID || null;
let routeCache = saved.routeCache || {};
let telegramOffset = saved.telegramOffset || 0;
let lastSeenMap = saved.lastSeenMap || {}; // icao -> epoch seconds (persisted)
let aircraftState = {};
let nearbyCallsigns = {}; // hex -> {callsign} from geofence nearby aircraft
let trailData = {}; // icao -> [{lat, lon, ts}]
let pollTimer = null;
const removedIcaos = new Set(saved.removedIcaos || []); // ICAOs removed via web/bot, blocks re-add from extension sync
let telegramEnabled = saved.telegramEnabled !== false; // default ON
let favoriteAirports = saved.favoriteAirports || []; // ICAO codes always shown on map
let geofence = {
  enabled: saved.geofence?.enabled || false,
  lat: saved.geofence?.lat ?? 32.0,
  lon: saved.geofence?.lon ?? 34.9,
  radiusNm: saved.geofence?.radiusNm ?? 25,
  seenIcaos: new Set(),
};
const weatherCache = {}; // ICAO code -> { metar, taf, ts }
const speedHistory = {}; // icao -> [last N groundspeeds]
let sourceRotationIndex = 0; // Round-robin index for fast ADS-B polling
let geofenceRotationIndex = 0; // Round-robin index for fast geofence polling

// ── Runway Database ──
let runwayDB = {};
try {
  const rwPath = path.join(__dirname, 'runways.json');
  if (fs.existsSync(rwPath)) {
    runwayDB = JSON.parse(fs.readFileSync(rwPath, 'utf8').replace(/^\uFEFF/, ''));
    console.log(`🛬 Runway DB loaded: ${Object.keys(runwayDB).length} airports`);
  }
} catch (e) { console.warn('⚠️ Could not load runways.json:', e.message); }

// ── Airport Coordinates Database (OurAirports) ──
let airportDB = {};
try {
  const apPath = path.join(__dirname, 'airports.json');
  if (fs.existsSync(apPath)) {
    airportDB = JSON.parse(fs.readFileSync(apPath, 'utf8'));
    console.log(`📍 Airport DB loaded: ${Object.keys(airportDB).length} airports`);
  }
} catch (e) { console.warn('⚠️ Could not load airports.json:', e.message); }

// ── Runway Landing History ──
// Tracks confirmed landings to improve prediction.
// Format: { "LLBG": [{ runway: "12", ts: epoch, windDir: 310, windSpeed: 12 }, ...] }
const RWY_HISTORY_FILE = path.join(__dirname, 'runway_history.json');
let runwayHistory = {};
try {
  if (fs.existsSync(RWY_HISTORY_FILE)) {
    runwayHistory = JSON.parse(fs.readFileSync(RWY_HISTORY_FILE, 'utf8'));
    const totalEntries = Object.values(runwayHistory).reduce((s, arr) => s + arr.length, 0);
    console.log(`📊 Runway history loaded: ${totalEntries} landings at ${Object.keys(runwayHistory).length} airports`);
  }
} catch (e) { console.warn('⚠️ Could not load runway_history.json:', e.message); }

function saveRunwayHistory() {
  try {
    fs.writeFileSync(RWY_HISTORY_FILE, JSON.stringify(runwayHistory, null, 2));
  } catch (e) {}
}

// ── Ignored runways (never used for traffic) ──
const ignoredRunways = {
  'LLBG': ['03'],  // RWY 03 not used; 21 is the active direction
};

// Helper: get runways for an airport, filtering out ignored designators
function getRunways(icao) {
  const rwys = runwayDB[icao];
  if (!rwys || rwys.length === 0) return rwys;
  const ignored = ignoredRunways[icao];
  if (!ignored || ignored.length === 0) return rwys;
  const result = [];
  for (const rw of rwys) {
    const leOk = rw.le && !ignored.includes(rw.le);
    const heOk = rw.he && !ignored.includes(rw.he);
    if (!leOk && !heOk) continue; // both ends ignored, skip
    result.push({
      le: leOk ? rw.le : null, lh: leOk ? rw.lh : null,
      he: heOk ? rw.he : null, hh: heOk ? rw.hh : null,
    });
  }
  return result;
}

// ── NOTAM-based runway closures ──
// Tracks which runways are closed via NOTAMs
const closedRunways = {}; // { "LLBG": ["12/30"], ... }
let notamLastFetch = 0;

async function fetchNotamsForAirport(icaoCode) {
  try {
    const res = await fetchWithTimeout(
      'https://notams.aim.faa.gov/notamSearch/search',
      10000,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `searchType=0&designatorsForNotamSearch=${icaoCode}&notamType=N`,
      }
    );
    if (!res.ok) return;
    const html = await res.text();
    // Look for runway closures: "RWY 12/30 CLSD" or "RWY 08 CLOSED" etc.
    const closed = [];
    const patterns = [
      /RWY\s*(\d{2}[LRC]?(?:\/\d{2}[LRC]?)?)\s+(?:CLSD|CLOSED)/gi,
      /(\d{2}[LRC]?\/\d{2}[LRC]?)\s+(?:CLSD|CLOSED)/gi,
    ];
    for (const pat of patterns) {
      let m;
      while ((m = pat.exec(html)) !== null) {
        closed.push(m[1].toUpperCase());
      }
    }
    closedRunways[icaoCode] = [...new Set(closed)];
    if (closed.length > 0) {
      console.log(`🚫 NOTAM: ${icaoCode} closed runways: ${closed.join(', ')}`);
    }
  } catch (e) {}
}

// ── Geofence airport tracking ──
// Auto-detect nearest airports in geofence and keep their METAR/NOTAM fresh
let geofenceAirports = []; // [ { icao, lat, lon, distNm } ]

function findNearestAirports(lat, lon, radiusNm, maxCount = 3) {
  const results = [];
  for (const [icao, apt] of Object.entries(airportDB)) {
    if (!apt.lat || !apt.lon) continue;
    // Only include airports that have runway data
    if (!runwayDB[icao] || runwayDB[icao].length === 0) continue;
    const dist = haversineNm(lat, lon, apt.lat, apt.lon);
    if (dist <= radiusNm) {
      results.push({ icao, lat: apt.lat, lon: apt.lon, distNm: Math.round(dist), name: apt.name || '' });
    }
  }
  results.sort((a, b) => a.distNm - b.distNm);
  return results.slice(0, maxCount);
}

// ── Telegram API ──
async function tg(method, body = {}) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function sendMessage(text, parseMode = 'HTML') {
  if (!CHAT_ID || !telegramEnabled) return;
  try {
    await tg('sendMessage', { chat_id: CHAT_ID, text, parse_mode: parseMode, disable_web_page_preview: true });
  } catch (e) {
    console.error('Failed to send Telegram message:', e.message);
  }
}

async function sendPushNotification(title, bodyText) {
  if (!db || !process.env.VAPID_PUBLIC_KEY) return;
  try {
    const subs = await db.collection('subscriptions').find({}).toArray();
    for (const sub of subs) {
      try {
        await webpush.sendNotification(sub, JSON.stringify({ title, body: bodyText }));
      } catch (e) {
        if (e.statusCode === 410 || e.statusCode === 404) {
          // Subscription expired or unsubscribed
          await db.collection('subscriptions').deleteOne({ _id: sub._id });
        } else {
          console.error('Push notification error:', e.message);
        }
      }
    }
  } catch (e) {
    console.error('Failed to retrieve push subscriptions:', e.message);
  }
}

// ── Telegram Command Polling ──
async function pollTelegram() {
  try {
    const data = await tg('getUpdates', { offset: telegramOffset, timeout: 5 });
    if (!data.ok || !data.result) return;

    for (const update of data.result) {
      telegramOffset = update.update_id + 1;
      const msg = update.message;
      if (!msg || !msg.text) continue;

      const chatId = msg.chat.id;
      const text = msg.text.trim();

      if (text === '/start') {
        CHAT_ID = String(chatId);
        saveData();
        console.log(`✅ Chat ID set: ${CHAT_ID}`);
        await tg('sendMessage', {
          chat_id: chatId,
          text: '✅ <b>Aircraft Alert Bot connected!</b>\n\nYou will receive notifications when tracked aircraft:\n✈️ Appear on radar\n🛫 Take off\n🛬 Land\n📡 Go off-radar\n\nCommands:\n/status — Current aircraft states\n/list — Show watchlist\n/add &lt;hex&gt; — Add aircraft by ICAO hex\n/remove &lt;hex&gt; — Remove aircraft',
          parse_mode: 'HTML',
        });
      } else if (text === '/status') {
        await handleStatus(chatId);
      } else if (text === '/list') {
        await handleList(chatId);
      } else if (text.startsWith('/add ')) {
        await handleAdd(chatId, text.slice(5).trim());
      } else if (text.startsWith('/remove ')) {
        await handleRemove(chatId, text.slice(8).trim());
      }
    }
  } catch (e) {}
}

async function handleStatus(chatId) {
  if (watchlist.length === 0) {
    await tg('sendMessage', { chat_id: chatId, text: '📋 Watchlist is empty.', parse_mode: 'HTML' });
    return;
  }

  const lines = watchlist.map(item => {
    const icao = (item.icao24 || '').toLowerCase();
    const state = aircraftState[icao];
    const reg = item.registration || icao.toUpperCase();
    
    if (!state || state.status === 'Unknown') {
      const dest = state?.last_destination && state.last_destination !== 'N/A'
        ? ` · Landed: ${state.last_destination}` : '';
      return `○ <b>${reg}</b> — No Signal${dest}`;
    }
    
    const status = state.on_ground ? '◻ Ground' : '● Airborne';
    const alt = state.altitude && !state.on_ground ? ` · ${Number(state.altitude).toLocaleString()} ft` : '';
    const cs = state.callsign ? ` · ${state.callsign}` : '';
    const route = state.origin && state.destination ? `\n   ${state.origin} → ${state.destination}` : '';
    
    return `${state.on_ground ? '◻' : '●'} <b>${reg}</b>${cs}${alt}${route}`;
  });

  await tg('sendMessage', { chat_id: chatId, text: lines.join('\n\n'), parse_mode: 'HTML' });
}

async function handleList(chatId) {
  if (watchlist.length === 0) {
    await tg('sendMessage', { chat_id: chatId, text: '📋 Watchlist is empty.', parse_mode: 'HTML' });
    return;
  }
  const lines = watchlist.map(item => {
    const reg = item.registration || item.icao24?.toUpperCase();
    return `• <b>${reg}</b> — <code>${(item.icao24 || '').toUpperCase()}</code>`;
  });
  await tg('sendMessage', { chat_id: chatId, text: `📋 <b>Watchlist (${watchlist.length}):</b>\n\n${lines.join('\n')}`, parse_mode: 'HTML' });
}

async function handleAdd(chatId, input) {
  const normalized = input.trim().replace(/[-\s]/g, '').toUpperCase();
  if (!normalized) {
    if (chatId) await tg('sendMessage', { chat_id: chatId, text: '❌ Usage: /add &lt;registration, hex, or flight number&gt;', parse_mode: 'HTML' });
    return;
  }

  const isHex = /^[0-9A-F]{6}$/.test(normalized);
  // If original input had a dash, it's a registration (e.g. XU-761, 4X-EKA)
  const hadDash = input.trim().includes('-');
  const isFlightNum = !hadDash && /^[A-Z]{2,4}\d{1,5}$/.test(normalized);

  let finalIcao = null;
  let finalReg = null;
  let details = {};

  if (chatId) await tg('sendMessage', { chat_id: chatId, text: `🔍 Looking up <b>${input.trim()}</b>...`, parse_mode: 'HTML' });

  // Helper: try a live ADS-B lookup, return { hex, reg, model } or null
  async function tryLive(url) {
    try {
      const res = await fetchWithTimeout(url, 6000);
      if (!res.ok) return null;
      const data = await res.json();
      const ac = data.ac?.[0];
      if (ac?.hex) return { hex: ac.hex.toLowerCase(), reg: ac.r || null, model: ac.t || null, operator: ac.ownOp || null };
    } catch (e) {}
    return null;
  }

  // Helper: try all 4 ADS-B sources in parallel, return first successful result
  async function tryAllLiveSources(pathBuilder) {
    const sources = [
      { base: 'https://api.airplanes.live/v2', name: 'airplanes.live' },
      { base: 'https://api.adsb.lol/v2', name: 'adsb.lol' },
      { base: 'https://api.adsb.one/v2', name: 'adsb.one' },
      { base: 'https://opendata.adsb.fi/api/v2', name: 'adsb.fi' },
    ];
    const results = await Promise.allSettled(
      sources.map(s => tryLive(`${s.base}/${pathBuilder(s.name)}`))
    );
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) return r.value;
    }
    return null;
  }

  if (isHex) {
    // ── Direct hex code ──
    finalIcao = normalized.toLowerCase();
    finalReg = normalized;
    const live = await tryAllLiveSources(() => `hex/${finalIcao}`);
    if (live) {
      if (live.reg) finalReg = live.reg;
      if (live.model) details.model = live.model;
      if (live.operator) details.operator = live.operator;
    }
    // Also try adsbdb for static info
    try {
      const res = await fetchWithTimeout(`https://api.adsbdb.com/v0/aircraft/${finalIcao}`, 5000);
      if (res.ok) {
        const data = await res.json();
        const ac = data?.response?.aircraft;
        if (ac) {
          if (ac.registration) finalReg = ac.registration;
          details.model = details.model || ac.icao_type || ac.type;
          details.operator = details.operator || ac.registered_owner;
        }
      }
    } catch (e) {}

  } else if (isFlightNum) {
    // ── Flight number (e.g. MSR785, ELY315) ──
    // Try all live sources by callsign in parallel
    const live = await tryAllLiveSources((name) => `callsign/${normalized}`);
    if (live) {
      finalIcao = live.hex;
      finalReg = live.reg || normalized;
      details.model = live.model;
      details.operator = live.operator;
    }

    // If not found live, try aviationstack to get the registration, then look up the hex
    if (!finalIcao) {
      try {
        const res = await fetchWithTimeout(
          `https://api.aviationstack.com/v1/flights?access_key=${AVIATIONSTACK_KEY}&flight_icao=${normalized}&limit=1`, 8000
        );
        if (res.ok) {
          const data = await res.json();
          const fl = data?.data?.[0];
          if (fl?.aircraft?.icao24) {
            finalIcao = fl.aircraft.icao24.toLowerCase();
            finalReg = fl.aircraft.registration || normalized;
            details.model = fl.aircraft.iata_type || null;
          } else if (fl?.aircraft?.registration) {
            // Got registration but no hex — look up by registration
            const regLive = await tryAllLiveSources((name) => {
              return name === 'adsb.lol' ? `registration/${fl.aircraft.registration.replace(/-/g,'')}` : `reg/${fl.aircraft.registration.replace(/-/g,'')}`;
            });
            if (regLive) {
              finalIcao = regLive.hex;
              finalReg = regLive.reg || fl.aircraft.registration;
              details.model = regLive.model;
            }
          }
        }
      } catch (e) {}
    }

    // Try adsbdb callsign → ICAO callsign → live lookup
    if (!finalIcao) {
      try {
        const res = await fetchWithTimeout(`https://api.adsbdb.com/v0/callsign/${normalized}`, 5000);
        if (res.ok) {
          const data = await res.json();
          const route = data?.response?.flightroute;
          if (route?.callsign_icao) {
            const csLive = await tryAllLiveSources(() => `callsign/${route.callsign_icao}`);
            if (csLive) {
              finalIcao = csLive.hex;
              finalReg = csLive.reg || normalized;
              details.model = csLive.model;
            }
          }
        }
      } catch (e) {}
    }

    // Last resort: try the IATA flight code variant (e.g. MS785 vs MSR785)
    if (!finalIcao) {
      try {
        const res = await fetchWithTimeout(
          `https://api.aviationstack.com/v1/flights?access_key=${AVIATIONSTACK_KEY}&flight_iata=${normalized}&limit=1`, 8000
        );
        if (res.ok) {
          const data = await res.json();
          const fl = data?.data?.[0];
          if (fl?.aircraft?.icao24) {
            finalIcao = fl.aircraft.icao24.toLowerCase();
            finalReg = fl.aircraft.registration || normalized;
          } else if (fl?.flight?.icao) {
            // Try the ICAO callsign from aviationstack
            const csLive = await tryAllLiveSources(() => `callsign/${fl.flight.icao}`);
            if (csLive) {
              finalIcao = csLive.hex;
              finalReg = csLive.reg || normalized;
              details.model = csLive.model;
            }
          }
        }
      } catch (e) {}
    }

  } else {
    // ── Registration (e.g. 4X-EKA, SU-GEL) ──
    const regNorm = normalized.replace(/[-\s]/g, '');
    const regOriginal = input.trim().toUpperCase();

    // Try all 4 sources in parallel — with original format (preserving dashes)
    let live = await tryAllLiveSources((name) => {
      return name === 'adsb.lol' ? `registration/${regOriginal}` : `reg/${regOriginal}`;
    });
    // If not found with dashes, try without
    if (!live) {
      live = await tryAllLiveSources((name) => {
        return name === 'adsb.lol' ? `registration/${regNorm}` : `reg/${regNorm}`;
      });
    }
    if (live) {
      finalIcao = live.hex;
      finalReg = live.reg || regOriginal;
      details.model = live.model;
      details.operator = live.operator;
    }

    // Fallback: adsbdb — try both formats
    if (!finalIcao) {
      const variants = [regOriginal, regNorm];
      for (const variant of variants) {
        if (finalIcao) break;
        try {
          const res = await fetchWithTimeout(`https://api.adsbdb.com/v0/aircraft/${variant}`, 5000);
          if (res.ok) {
            const data = await res.json();
            const ac = data?.response?.aircraft;
            if (ac?.mode_s) {
              finalIcao = ac.mode_s.toLowerCase();
              finalReg = ac.registration || regOriginal;
              details.model = ac.icao_type;
              details.operator = ac.registered_owner;
            }
          }
        } catch (e) {}
      }
    }

    // Fallback: aviationstack aircraft database
    if (!finalIcao) {
      try {
        const res = await fetchWithTimeout(
          `https://api.aviationstack.com/v1/airplanes?access_key=${AVIATIONSTACK_KEY}&search=${regNorm}&limit=1`, 8000
        );
        if (res.ok) {
          const data = await res.json();
          const plane = data?.data?.[0];
          if (plane?.icao_code_hex) {
            finalIcao = plane.icao_code_hex.toLowerCase();
            finalReg = plane.registration_number || regOriginal;
            details.model = plane.model_name;
          }
        }
      } catch (e) {}
    }
  }

  if (!finalIcao) {
    if (chatId) await tg('sendMessage', { chat_id: chatId, text: `❌ Could not find <b>${input.trim()}</b>`, parse_mode: 'HTML' });
    return { ok: false, error: 'Not found' };
  }

  // Check duplicate
  if (watchlist.find(w => (w.icao24 || '').toLowerCase() === finalIcao)) {
    if (chatId) await tg('sendMessage', { chat_id: chatId, text: `⚠️ <b>${finalReg}</b> already in watchlist`, parse_mode: 'HTML' });
    removedIcaos.delete(finalIcao); // Allow sync to keep it
    return { ok: true, duplicate: true };
  }

  removedIcaos.delete(finalIcao); // Clear from blocklist if previously removed
  const entry = { registration: finalReg, icao24: finalIcao, details };
  watchlist.push(entry);
  saveData();

  if (chatId) await tg('sendMessage', { chat_id: chatId, text: `✅ Added <b>${finalReg}</b> (<code>${finalIcao.toUpperCase()}</code>)${details.model ? '\n✈️ ' + details.model : ''}${details.operator ? '\n🏢 ' + details.operator : ''}`, parse_mode: 'HTML' });
  
  broadcastState(); // Push update to web clients
  return { ok: true, entry };
}

async function handleRemove(chatId, input) {
  const hex = input.trim().replace(/[-\s]/g, '').toLowerCase();
  const before = watchlist.length;
  // Collect ICAOs being removed so sync won't re-add them
  const removing = new Set();
  watchlist.forEach(w => {
    const wHex = (w.icao24 || '').toLowerCase();
    const wReg = (w.registration || '').replace(/[-\s]/g, '').toLowerCase();
    if (wHex === hex || wReg === hex) removing.add(wHex);
  });
  watchlist = watchlist.filter(w => {
    const wHex = (w.icao24 || '').toLowerCase();
    return !removing.has(wHex);
  });
  if (watchlist.length < before) {
    removing.forEach(icao => {
      delete aircraftState[icao];
      delete trailData[icao];
      removedIcaos.add(icao); // Block re-add from extension sync
    });
    saveData();
    if (chatId) await tg('sendMessage', { chat_id: chatId, text: `✅ Removed <code>${hex.toUpperCase()}</code>`, parse_mode: 'HTML' });
    broadcastState();
    return { ok: true };
  } else {
    if (chatId) await tg('sendMessage', { chat_id: chatId, text: '❌ Not found in watchlist.', parse_mode: 'HTML' });
    return { ok: false, error: 'Not found' };
  }
}

// ── ADS-B Polling ──
async function fetchWithTimeout(url, timeout = 10000) {
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(timeout),
  });
  // Ensure body is consumed even on error (prevents Node.js memory leak)
  if (!res.ok) {
    try { await res.text(); } catch (_) {}
  }
  return res;
}

async function fetchWeather(icaoCode, force = false) {
  if (!icaoCode || icaoCode === 'N/A') return null;
  const cached = weatherCache[icaoCode];
  if (!force && cached && Date.now() - cached.ts < 30 * 60 * 1000) return cached; // 30min cache

  try {
    const [metarRes, tafRes] = await Promise.all([
      fetchWithTimeout(`https://aviationweather.gov/api/data/metar?ids=${icaoCode}&format=json`, 8000),
      fetchWithTimeout(`https://aviationweather.gov/api/data/taf?ids=${icaoCode}&format=json`, 8000),
    ]);

    let metar = null, taf = null, parsed = null;
    if (metarRes.ok) {
      const data = await metarRes.json();
      if (data?.[0]) {
        metar = data[0].rawOb || data[0].rawMETAR || null;
        parsed = {
          wdir: data[0].wdir ?? null,
          wspd: data[0].wspd ?? null,
          wgst: data[0].wgst ?? null,
          temp: data[0].temp ?? null,
          dewp: data[0].dewp ?? null,
          visib: data[0].visib ?? null,
          altim: data[0].altim ?? null,
          fltCat: data[0].fltCat ?? null,
          cover: data[0].cover ?? null,
          clouds: data[0].clouds ?? [],
          obsTime: data[0].obsTime ? data[0].obsTime * 1000 : null,
          reportTime: data[0].reportTime ?? null,
        };
        const ceilingCloud = (data[0].clouds || []).find(c => c.cover === 'BKN' || c.cover === 'OVC');
        parsed.ceiling = ceilingCloud ? ceilingCloud.base : null;
      }
    }
    if (tafRes.ok) {
      const data = await tafRes.json();
      if (data?.[0]) taf = data[0].rawOb || data[0].rawTAF || null;
    }

    const result = { metar, taf, parsed, ts: Date.now() };
    weatherCache[icaoCode] = result;
    return result;
  } catch (e) { return null; }
}

async function pollAircraft() {
  if (watchlist.length === 0) return;

  const icao24s = watchlist.map(a => (a.icao24 || '').toLowerCase()).filter(Boolean);
  const prevState = {};
  // Deep copy previous state for change detection
  for (const k of Object.keys(aircraftState)) {
    prevState[k] = { ...aircraftState[k] };
  }
  const nowSec = Math.floor(Date.now() / 1000);

  // ADS-B source rotation for fast polling
  const allSources = [
    { base: 'https://api.airplanes.live/v2/hex/', name: 'airplanes.live' },
    { base: 'https://api.adsb.lol/v2/hex/', name: 'adsb.lol' },
    { base: 'https://opendata.adsb.fi/api/v2/hex/', name: 'adsb.fi' },
  ];

  const hexStr = icao24s.join(',');
  const currentInterval = pollTimer?._currentInterval || POLL_INTERVAL;
  const useFastMode = currentInterval < 5000;

  let results;
  if (useFastMode) {
    // Round-robin: hit one source per tick (each source hit every 3s at 1s interval)
    const src = allSources[sourceRotationIndex % allSources.length];
    sourceRotationIndex++;
    try {
      const res = await fetchWithTimeout(src.base + hexStr, 4000);
      if (res.ok) {
        const data = await res.json();
        results = [{ status: 'fulfilled', value: { name: src.name, ac: data.ac || [] } }];
      } else {
        results = [{ status: 'rejected' }];
      }
    } catch (e) {
      results = [{ status: 'rejected' }];
    }
  } else {
    // Slow mode: hit all sources in parallel for best data quality
    const sources = allSources.map(s => ({ url: s.base + hexStr, name: s.name }));
    results = await Promise.allSettled(
      sources.map(async (src) => {
        const res = await fetchWithTimeout(src.url, 8000);
        if (!res.ok) throw new Error(`${src.name}: ${res.status}`);
        const data = await res.json();
        return { name: src.name, ac: data.ac || [] };
      })
    );
  }

  // Merge: pick freshest data per aircraft across all sources
  const merged = {}; // icao -> { ac, source, freshness }
  results.forEach(r => {
    if (r.status !== 'fulfilled') return;
    const { name, ac: acList } = r.value;
    acList.forEach(ac => {
      const icao = (ac.hex || '').toLowerCase();
      if (!icao24s.includes(icao)) return;
      const freshness = ac.seen ?? 999;
      // In fast mode, prefer new data if fresher than what we have
      const existing = merged[icao];
      if (!existing || freshness < existing.freshness) {
        merged[icao] = { ac, source: name, freshness };
      }
    });
  });

  const successCount = Object.keys(merged).length;
  const sourceNames = [...new Set(results.filter(r => r.status === 'fulfilled').map(r => r.value.name))];

  // Build registration map from watchlist (user's input is more authoritative than API DB)
  const wlRegMap = {};
  watchlist.forEach(w => { if (w.icao24) wlRegMap[w.icao24.toLowerCase()] = w.registration; });

  // Apply merged data
  Object.entries(merged).forEach(([icao, { ac, source }]) => {
    const prev = aircraftState[icao] || {};
    const gs = ac.gs || 0;

    // Track speed history for ETA smoothing
    if (gs > 0) {
      if (!speedHistory[icao]) speedHistory[icao] = [];
      speedHistory[icao].push(gs);
      if (speedHistory[icao].length > 5) speedHistory[icao].shift();
    }
    const avgSpeed = speedHistory[icao]?.length > 0
      ? speedHistory[icao].reduce((a, b) => a + b, 0) / speedHistory[icao].length
      : gs;

    // Prefer watchlist registration over API's r field (API DB can be stale)
    const resolvedReg = wlRegMap[icao] || ac.r || null;
    // In fast mode, skip stale position data (prevent jumping between sources)
    const prevSeen = prev._lastSeenPos ?? Infinity;
    const newSeen = ac.seen_pos ?? ac.seen ?? 999;
    const positionIsFresher = newSeen <= prevSeen + 0.5; // allow 0.5s tolerance

    // Use new lat/lon only if position is fresher
    const useLat = (positionIsFresher && ac.lat != null) ? ac.lat : (prev.lat || null);
    const useLon = (positionIsFresher && ac.lon != null) ? ac.lon : (prev.lon || null);

    aircraftState[icao] = {
      icao24: icao,
      callsign: (ac.flight || '').trim(),
      on_ground: ac.alt_baro === 'ground',
      altitude: ac.alt_baro === 'ground' ? 0 : ac.alt_baro,
      velocity: gs,
      heading: ac.track,
      nav_heading: ac.nav_heading || null,
      vertical_rate: ac.baro_rate,
      squawk: ac.squawk,
      registration: resolvedReg,
      model: ac.t || null,
      operator: ac.ownOp || prev.operator || null,
      last_seen: nowSec,
      lat: useLat,
      lon: useLon,
      signal_source: source,
      _lastSeenPos: (positionIsFresher && ac.lat != null) ? newSeen : prevSeen,
      // Carry forward route data
      origin: prev.origin || null,
      destination: prev.destination || null,
      origin_city: prev.origin_city || null,
      dest_city: prev.dest_city || null,
      origin_lat: prev.origin_lat || null,
      origin_lon: prev.origin_lon || null,
      dest_lat: prev.dest_lat || null,
      dest_lon: prev.dest_lon || null,
      eta: prev.eta || null,
      // Calculated ETA fields (computed below)
      calc_eta: null,
      remaining_nm: null,
      progress: null,
      avg_speed: Math.round(avgSpeed),
      // Runway prediction (computed below)
      predicted_runway: prev.predicted_runway || null,
      runway_wind: prev.runway_wind || null,
    };

    // Calculate ETA from position + speed
    const state = aircraftState[icao];
    if (state.dest_lat && state.dest_lon && ac.lat && ac.lon && avgSpeed > 50) {
      const distNm = haversineNm(ac.lat, ac.lon, state.dest_lat, state.dest_lon);
      state.remaining_nm = Math.round(distNm);
      const hoursLeft = distNm / avgSpeed;
      // Add approach buffer: 8 min if > 50nm, 5 min if < 50nm
      const bufferMin = distNm > 50 ? 8 : 5;
      const etaMs = Date.now() + (hoursLeft * 3600000) + (bufferMin * 60000);
      state.calc_eta = new Date(etaMs).toISOString();
      // Progress: origin->dest vs current->dest
      if (state.origin_lat && state.origin_lon) {
        const totalNm = haversineNm(state.origin_lat, state.origin_lon, state.dest_lat, state.dest_lon);
        state.progress = totalNm > 0 ? Math.min(99, Math.round((1 - distNm / totalNm) * 100)) : null;
      }
    }

    // Track position trail
    if (ac.lat && ac.lon) {
      if (!trailData[icao]) trailData[icao] = [];
      const trail = trailData[icao];
      const last = trail[trail.length - 1];
      if (!last || last.lat !== ac.lat || last.lon !== ac.lon) {
        trail.push({ lat: ac.lat, lon: ac.lon, alt: ac.alt_baro, ts: nowSec });
        if (trail.length > 100) trail.splice(0, trail.length - 100);
      }
    }
  });

  // Update persistent last-seen timestamps
  icao24s.forEach(icao => {
    if (aircraftState[icao]?.last_seen) {
      lastSeenMap[icao] = aircraftState[icao].last_seen;
    }
  });

  // Route lookups (max 3 per cycle)
  await lookupRoutes(icao24s);

  // Mark unknown & preserve destination
  icao24s.forEach(icao => {
    if (!aircraftState[icao] || (nowSec - (aircraftState[icao].last_seen || 0) > 600)) {
      const prev = prevState[icao] || aircraftState[icao] || {};
      aircraftState[icao] = {
        icao24: icao,
        status: 'Unknown',
        callsign: prev.callsign || null,
        registration: prev.registration || null,
        origin: prev.origin || null,
        destination: prev.destination || prev.last_destination || null,
        origin_city: prev.origin_city || null,
        dest_city: prev.dest_city || prev.last_dest_city || null,
        origin_lat: prev.origin_lat || null,
        origin_lon: prev.origin_lon || null,
        dest_lat: prev.dest_lat || null,
        dest_lon: prev.dest_lon || null,
        last_destination: prev.destination || prev.last_destination || null,
        last_dest_city: prev.dest_city || prev.last_dest_city || null,
        last_seen: prev.last_seen || lastSeenMap[icao] || null,
      };
    }
  });

  // ── Detect state changes → send notifications ──
  const regMap = {};
  watchlist.forEach(w => { regMap[(w.icao24 || '').toLowerCase()] = w.registration || w.icao24; });

  for (const icao of icao24s) {
    const prev = prevState[icao];
    const curr = aircraftState[icao];
    const reg = curr?.registration || regMap[icao] || icao.toUpperCase();

    // APPEARED
    const wasOff = !prev || prev.status === 'Unknown';
    const isOn = curr && curr.status !== 'Unknown' && curr.last_seen;
    if (wasOff && isOn) {
      const cs = curr.callsign ? `Flight ${curr.callsign}` : '';
      const model = curr.model ? ` · ${curr.model}` : '';
      const route = (curr.origin && curr.destination && curr.origin !== 'N/A')
        ? `\n${curr.origin}${curr.origin_city ? ' ('+curr.origin_city+')' : ''} → ${curr.destination}${curr.dest_city ? ' ('+curr.dest_city+')' : ''}`
        : '';
      const ground = curr.on_ground ? 'on ground' : (curr.altitude ? `at ${Number(curr.altitude).toLocaleString()} ft` : 'airborne');
      const speed = curr.velocity ? ` · ${Math.round(curr.velocity)} kts` : '';
      await sendMessage(`✈️ <b>${reg} is active!</b>\n${cs}${model}\n${ground}${speed}${route}`);
      await sendPushNotification('Aircraft Active', `${reg} is active! ${cs.trim()}`);
    }

    // TAKEOFF
    const wasOnGround = prev && prev.status !== 'Unknown' && prev.on_ground;
    const isAirborne = curr && curr.status !== 'Unknown' && !curr.on_ground;
    if (wasOnGround && isAirborne) {
      const cs = curr.callsign ? `Flight ${curr.callsign}` : '';
      const dest = curr.destination && curr.destination !== 'N/A' ? ` → ${curr.destination}` : '';
      await sendMessage(`🛫 <b>${reg} has taken off!</b>\n${cs}${dest}`);
      await sendPushNotification('Takeoff Alert', `${reg} has taken off!`);
    }

    // LANDED
    const wasAirborne = prev && prev.status !== 'Unknown' && !prev.on_ground;
    const isGround = curr && curr.status !== 'Unknown' && curr.on_ground;
    if (wasAirborne && isGround) {
      const cs = curr.callsign ? `Flight ${curr.callsign}` : '';
      const dest = curr.destination && curr.destination !== 'N/A'
        ? `\n${curr.destination}${curr.dest_city ? ' ('+curr.dest_city+')' : ''}`
        : '';
      await sendMessage(`🛬 <b>${reg} has landed</b>\n${cs}${dest}`);
      await sendPushNotification('Landing Alert', `${reg} has landed.`);
    }

    // OFF-RADAR — with grace period to avoid false triggers from API gaps
    const wasOn2 = prev && prev.status !== 'Unknown' && prev.last_seen;
    const isOff = curr && curr.status === 'Unknown';
    if (wasOn2 && isOff) {
      // Start grace timer — don't trigger immediately
      if (!curr._offRadarSince) curr._offRadarSince = Date.now();
      const offDuration = Date.now() - curr._offRadarSince;
      if (offDuration >= 120000) { // 2 minute grace period
        const dest = curr.last_destination && curr.last_destination !== 'N/A'
          ? `\nLast destination: ${curr.last_destination}${curr.last_dest_city ? ' ('+curr.last_dest_city+')' : ''}`
          : '';
        await sendMessage(`📡 <b>${reg} went off-radar</b>${dest}`);
        delete curr._offRadarSince; // Don't re-trigger
      }
    } else if (!isOff && curr?._offRadarSince) {
      // Aircraft came back — cancel grace timer
      delete curr._offRadarSince;
    }
  }

  // Predict runways based on weather + heading
  await predictRunwaysForAll();

  // Broadcast to web clients
  broadcastState();
}

// ── Route Lookups (multi-source) ──
const ROUTE_TTL = 2 * 60 * 60 * 1000;
const ROUTE_TTL_AS = 6 * 60 * 60 * 1000; // Aviationstack - trust longer
const FAIL_TTL = 5 * 60 * 1000; // Retry failed lookups faster

async function lookupRoutes(icao24s) {
  const needsRoute = [];

  for (const icao of icao24s) {
    const state = aircraftState[icao];
    if (!state || !state.callsign) continue;
    const isUnknown = state.status === 'Unknown';

    const cached = routeCache[state.callsign];
    const age = cached ? (Date.now() - (cached._ts || 0)) : Infinity;
    const ttl = cached?._src === 'aviationstack' ? ROUTE_TTL_AS : ROUTE_TTL;

    if (cached && cached.origin !== 'N/A' && age < ttl) {
      // Apply cached route
      state.origin = cached.origin;
      state.destination = cached.destination;
      state.origin_city = cached.origin_city || '';
      state.dest_city = cached.dest_city || '';
      state.origin_lat = cached.origin_lat || null;
      state.origin_lon = cached.origin_lon || null;
      state.dest_lat = cached.dest_lat || null;
      state.dest_lon = cached.dest_lon || null;
      if (cached.eta) state.eta = cached.eta;
      // Queue for coordinate resolution if missing
      if ((state.origin && !state.origin_lat) || (state.destination && !state.dest_lat)) {
        needsRoute.push({ icao, callsign: state.callsign, coordsOnly: true });
      }
    } else if (cached && cached.origin === 'N/A' && age < FAIL_TTL) {
      // Recently failed — skip
    } else if (!isUnknown) {
      // Only do full route lookup for non-Unknown aircraft
      needsRoute.push({ icao, callsign: state.callsign });
    }
  }

  const batch = needsRoute.slice(0, 10); // Process more per cycle
  for (const { icao, callsign, coordsOnly } of batch) {
    // If we just need coordinates, resolve them and skip route lookup
    if (coordsOnly) {
      const state = aircraftState[icao];
      if (state) await resolveAirportCoords(state, callsign);
      continue;
    }
    let found = false;

    // Verify route: reject if origin is implausibly far from aircraft's position
    const verifyRoute = (rd) => {
      if (!rd || rd.origin === 'N/A') return false;
      const st = aircraftState[icao];
      if (!st?.lat || !st?.lon) return true; // can't verify, accept
      const oLat = rd.origin_lat || airportDB[rd.origin]?.lat;
      const oLon = rd.origin_lon || airportDB[rd.origin]?.lon;
      if (!oLat || !oLon) return true; // can't verify, accept
      const distFromOrigin = haversineNm(st.lat, st.lon, oLat, oLon);
      const dLat = rd.dest_lat || airportDB[rd.destination]?.lat;
      const dLon = rd.dest_lon || airportDB[rd.destination]?.lon;
      if (dLat && dLon) {
        const routeLen = haversineNm(oLat, oLon, dLat, dLon);
        if (distFromOrigin > routeLen * 2.5 + 200) {
          console.log(`⚠️ Route rejected for ${callsign}: origin ${rd.origin} is ${Math.round(distFromOrigin)}nm (route ${Math.round(routeLen)}nm)`);
          return false;
        }
      } else if (distFromOrigin > 5000) {
        console.log(`⚠️ Route rejected for ${callsign}: origin ${rd.origin} is ${Math.round(distFromOrigin)}nm away`);
        return false;
      }
      return true;
    };

    // SOURCE 1: Aviationstack (real-time airline schedule — most accurate for CURRENT flight)
    if (!found) {
      try {
        const res = await fetchWithTimeout(
          `https://api.aviationstack.com/v1/flights?access_key=${AVIATIONSTACK_KEY}&flight_icao=${callsign}&limit=1`, 8000
        );
        if (res.ok) {
          const data = await res.json();
          const fl = data?.data?.[0];
          if (fl && fl.departure?.icao) {
            const routeData = {
              origin: fl.departure.icao,
              destination: fl.arrival?.icao || 'N/A',
              origin_city: fl.departure.airport || '',
              dest_city: fl.arrival?.airport || '',
              origin_lat: parseFloat(fl.departure?.latitude) || null,
              origin_lon: parseFloat(fl.departure?.longitude) || null,
              dest_lat: parseFloat(fl.arrival?.latitude) || null,
              dest_lon: parseFloat(fl.arrival?.longitude) || null,
              eta: fl.arrival?.estimated || fl.arrival?.scheduled || null,
              etd: fl.departure?.actual || fl.departure?.estimated || fl.departure?.scheduled || null,
              origin_tz: fl.departure?.timezone || null,
              dest_tz: fl.arrival?.timezone || null,
              _ts: Date.now(), _src: 'aviationstack',
            };
            if (verifyRoute(routeData)) {
              routeCache[callsign] = routeData;
              Object.assign(aircraftState[icao], {
                origin: routeData.origin, destination: routeData.destination,
                origin_city: routeData.origin_city, dest_city: routeData.dest_city,
                origin_lat: routeData.origin_lat, origin_lon: routeData.origin_lon,
                dest_lat: routeData.dest_lat, dest_lon: routeData.dest_lon,
                eta: routeData.eta, etd: routeData.etd,
                origin_tz: routeData.origin_tz, dest_tz: routeData.dest_tz,
              });
              found = true;
            }
          }
        }
      } catch (e) {}
    }

    // SOURCE 2: adsbdb (historical but has full airport data incl. coordinates & city)
    if (!found) {
      try {
        const res = await fetchWithTimeout(`https://api.adsbdb.com/v0/callsign/${callsign}`, 5000);
        if (res.ok) {
          const data = await res.json();
          const route = data?.response?.flightroute;
          if (route) {
            const routeData = {
              origin: route.origin?.icao_code || 'N/A',
              destination: route.destination?.icao_code || 'N/A',
              origin_city: route.origin?.municipality || '',
              dest_city: route.destination?.municipality || '',
              origin_lat: parseFloat(route.origin?.latitude) || null,
              origin_lon: parseFloat(route.origin?.longitude) || null,
              dest_lat: parseFloat(route.destination?.latitude) || null,
              dest_lon: parseFloat(route.destination?.longitude) || null,
              _ts: Date.now(), _src: 'adsbdb',
            };
            if (verifyRoute(routeData)) {
              routeCache[callsign] = routeData;
              Object.assign(aircraftState[icao], {
                origin: routeData.origin, destination: routeData.destination,
                origin_city: routeData.origin_city, dest_city: routeData.dest_city,
                origin_lat: routeData.origin_lat, origin_lon: routeData.origin_lon,
                dest_lat: routeData.dest_lat, dest_lon: routeData.dest_lon,
              });
              found = true;
            }
          }
        }
      } catch (e) {}
    }

    // SOURCE 3: hexdb.io (fast callsign → route, but may be stale)
    if (!found) {
      try {
        const res = await fetchWithTimeout(`https://hexdb.io/api/v1/route/icao/${callsign}`, 5000);
        if (res.ok) {
          const data = await res.json();
          if (data?.route && data.route.includes('-')) {
            const [orig, dest] = data.route.split('-');
            if (orig && dest) {
              const routeData = {
                origin: orig, destination: dest,
                origin_city: '', dest_city: '',
                _ts: Date.now(), _src: 'hexdb',
              };
              if (verifyRoute(routeData)) {
                routeCache[callsign] = routeData;
                Object.assign(aircraftState[icao], {
                  origin: routeData.origin, destination: routeData.destination,
                });
                found = true;
              }
            }
          }
        }
      } catch (e) {}
    }

    // SOURCE 4: OpenSky Network (real ADS-B departure/arrival)
    if (!found) {
      try {
        const now = Math.floor(Date.now() / 1000);
        const begin = now - 12 * 3600;
        const res = await fetchWithTimeout(
          `https://opensky-network.org/api/flights/aircraft?icao24=${icao}&begin=${begin}&end=${now}`, 8000
        );
        if (res.ok) {
          const flights = await res.json();
          const latest = flights.length > 0 ? flights[flights.length - 1] : null;
          if (latest && latest.estDepartureAirport) {
            const routeData = {
              origin: latest.estDepartureAirport,
              destination: latest.estArrivalAirport || 'N/A',
              origin_city: '', dest_city: '',
              _ts: Date.now(), _src: 'opensky',
            };
            if (verifyRoute(routeData)) {
              routeCache[callsign] = routeData;
              Object.assign(aircraftState[icao], {
                origin: routeData.origin, destination: routeData.destination,
              });
              found = true;
            }
          }
        }
      } catch (e) {}
    }

    // SOURCE 5: FlightRadar24 flight list (good for small/regional operators)
    if (!found) {
      try {
        const res = await fetchWithTimeout(
          `https://api.flightradar24.com/common/v1/flight/list.json?query=${callsign}&fetchBy=flight&limit=1`, 5000
        );
        if (res.ok) {
          const data = await res.json();
          const fl = data?.result?.response?.data?.[0];
          if (fl) {
            const orig = fl.airport?.origin?.code?.icao;
            const dest = fl.airport?.destination?.code?.icao;
            if (orig) {
              const routeData = {
                origin: orig,
                destination: dest || 'N/A',
                origin_city: fl.airport?.origin?.name || '',
                dest_city: fl.airport?.destination?.name || '',
                _ts: Date.now(), _src: 'fr24',
              };
              if (verifyRoute(routeData)) {
                routeCache[callsign] = routeData;
                Object.assign(aircraftState[icao], {
                  origin: routeData.origin, destination: routeData.destination,
                  origin_city: routeData.origin_city, dest_city: routeData.dest_city,
                });
                found = true;
              }
            }
          }
        }
      } catch (e) {}
    }

    if (!found) {
      routeCache[callsign] = { origin: 'N/A', destination: 'N/A', _ts: Date.now() };
    }

    // Resolve missing airport coordinates
    const state = aircraftState[icao];
    if (state && found) {
      await resolveAirportCoords(state, callsign);
    }

    await new Promise(r => setTimeout(r, 500));
  }

  if (batch.length > 0) saveData();
}

// Airport coordinate cache (IATA/ICAO -> {lat, lon, city})
const airportCoordCache = {};

async function lookupAirportCoords(code) {
  if (!code || code === 'N/A') return null;
  const cached = airportCoordCache[code];
  if (cached && cached.lat) return cached;
  // If previously failed via APIs, retry after 5 minutes
  if (cached === null && airportCoordCache[`${code}_ts`] && Date.now() - airportCoordCache[`${code}_ts`] < 300000) return null;

  // Source 1: Local airport database (instant, offline, 72K airports)
  if (airportDB[code]) {
    const ap = airportDB[code];
    const result = { lat: ap.lat, lon: ap.lon, city: ap.name || '' };
    airportCoordCache[code] = result;
    return result;
  }

  // Source 2: aviationstack API (fallback)
  try {
    const res = await fetchWithTimeout(
      `https://api.aviationstack.com/v1/airports?access_key=${AVIATIONSTACK_KEY}&icao_code=${code}&limit=1`, 8000
    );
    if (res.ok) {
      const data = await res.json();
      const ap = data?.data?.[0];
      if (ap?.latitude && ap?.longitude) {
        const result = { lat: parseFloat(ap.latitude), lon: parseFloat(ap.longitude), city: ap.airport_name || ap.city || '' };
        airportCoordCache[code] = result;
        return result;
      }
    }
  } catch (e) {}

  // Source 3: OpenStreetMap Nominatim (fallback, requires User-Agent)
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${code}+airport&format=json&limit=1`,
      { headers: { 'User-Agent': 'AircraftTracker/1.0', 'Accept': 'application/json' }, signal: AbortSignal.timeout(5000) }
    );
    if (res.ok) {
      const data = await res.json();
      if (data?.[0]?.lat && data?.[0]?.lon) {
        const result = { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon), city: data[0].display_name?.split(',')[0] || '' };
        airportCoordCache[code] = result;
        return result;
      }
    }
  } catch (e) {}

  // Mark as failed with timestamp so we retry after 5 min
  airportCoordCache[code] = null;
  airportCoordCache[`${code}_ts`] = Date.now();
  return null;
}

async function resolveAirportCoords(state, callsign) {
  let updated = false;
  // Resolve origin
  if (state.origin && state.origin !== 'N/A' && !state.origin_lat) {
    const coords = await lookupAirportCoords(state.origin);
    if (coords) {
      state.origin_lat = coords.lat;
      state.origin_lon = coords.lon;
      if (!state.origin_city) state.origin_city = coords.city;
      // Also update cache
      if (routeCache[callsign]) {
        routeCache[callsign].origin_lat = coords.lat;
        routeCache[callsign].origin_lon = coords.lon;
        if (!routeCache[callsign].origin_city) routeCache[callsign].origin_city = coords.city;
      }
      updated = true;
    }
  }
  // Resolve destination
  if (state.destination && state.destination !== 'N/A' && !state.dest_lat) {
    const coords = await lookupAirportCoords(state.destination);
    if (coords) {
      state.dest_lat = coords.lat;
      state.dest_lon = coords.lon;
      if (!state.dest_city) state.dest_city = coords.city;
      if (routeCache[callsign]) {
        routeCache[callsign].dest_lat = coords.lat;
        routeCache[callsign].dest_lon = coords.lon;
        if (!routeCache[callsign].dest_city) routeCache[callsign].dest_city = coords.city;
      }
      updated = true;
    }
  }
  // Pre-fetch weather for resolved airports (fire-and-forget)
  if (state.origin && state.origin !== 'N/A') fetchWeather(state.origin).catch(() => {});
  if (state.destination && state.destination !== 'N/A') fetchWeather(state.destination).catch(() => {});
  return updated;
}

// ── Runway Prediction ──
function predictRunway(destIcao, windDir, windSpeed, aircraftHeading, distToDestNm, trafficType) {
  if (!destIcao || !runwayDB[destIcao]) return null;
  const runways = getRunways(destIcao);
  if (!runways || runways.length === 0) return null;

  // Score each runway end (both directions)
  const candidates = [];
  runways.forEach(rw => {
    // Low-end
    if (rw.le && rw.lh != null) {
      candidates.push({ id: rw.le, heading: rw.lh });
    }
    // High-end
    if (rw.he && rw.hh != null) {
      candidates.push({ id: rw.he, heading: rw.hh });
    }
  });

  if (candidates.length === 0) return null;

  // Filter out NOTAM-closed runways
  const closed = closedRunways[destIcao] || [];
  const openCandidates = candidates.filter(c => {
    return !closed.some(cr => {
      // cr can be "12/30" or just "12"
      const parts = cr.split('/');
      return parts.includes(c.id.replace(/[LRC]$/, ''));
    });
  });
  // Use open candidates if any remain, otherwise fall back to all
  const activeCandidates = openCandidates.length > 0 ? openCandidates : candidates;

  // If wind data available, score by headwind
  let bestByWind = null;
  if (windDir != null && windSpeed != null && windDir !== 'VRB') {
    let bestScore = -Infinity;
    activeCandidates.forEach(c => {
      const angleDiff = ((windDir - c.heading) * Math.PI) / 180;
      const headwind = windSpeed * Math.cos(angleDiff);
      const crosswind = Math.abs(windSpeed * Math.sin(angleDiff));
      // Prefer max headwind, penalize crosswind
      const score = headwind - crosswind * 0.3;
      if (score > bestScore) {
        bestScore = score;
        bestByWind = { ...c, headwind: Math.round(headwind), crosswind: Math.round(crosswind) };
      }
    });
  }

  // Cross-validate with aircraft heading (if on approach: < 15nm, heading available)
  let bestByHeading = null;
  if (aircraftHeading != null && distToDestNm != null && distToDestNm < 15) {
    let bestDiff = 360;
    activeCandidates.forEach(c => {
      let diff = Math.abs(aircraftHeading - c.heading);
      if (diff > 180) diff = 360 - diff;
      if (diff < bestDiff) {
        bestDiff = diff;
        bestByHeading = { ...c, headingDiff: Math.round(diff) };
      }
    });
    // Only trust if within 20° of a runway
    if (bestByHeading && bestByHeading.headingDiff > 20) bestByHeading = null;
  }

  // Check recent landing/takeoff history
  let bestByHistory = null;
  let historyIsRecent = false; // within 15 minutes — very strong signal
  let historyIsFresh = false;  // within 1 hour — moderate signal
  const history = runwayHistory[destIcao] || [];
  const now = Date.now();
  const recentCutoff = now - 15 * 60 * 1000;    // 15 min
  const freshCutoff = now - 60 * 60 * 1000;     // 1 hour
  const staleCutoff = now - 24 * 60 * 60 * 1000; // 24h
  const recentLandings = history.filter(h => h.ts > staleCutoff && (!trafficType || h.type === trafficType));

  if (recentLandings.length > 0) {
    // Weight recent traffic much more heavily
    const counts = {};
    recentLandings.forEach(h => {
      // Recent traffic (≤15min) counts 10x, fresh (≤1hr) counts 3x, older counts 1x
      const weight = h.ts > recentCutoff ? 10 : h.ts > freshCutoff ? 3 : 1;
      counts[h.runway] = (counts[h.runway] || 0) + weight;
    });
    let maxCount = 0;
    let topRunway = null;
    Object.entries(counts).forEach(([rwy, cnt]) => {
      if (cnt > maxCount) { maxCount = cnt; topRunway = rwy; }
    });
    if (topRunway && maxCount >= 1) {
      const match = activeCandidates.find(c => c.id === topRunway);
      if (match) {
        bestByHistory = { ...match, landingCount: maxCount };
        // Check if there's very recent traffic (within 15 min)
        const veryRecent = recentLandings.filter(h => h.ts > recentCutoff && h.runway === topRunway);
        historyIsRecent = veryRecent.length > 0;
        const freshTraffic = recentLandings.filter(h => h.ts > freshCutoff && h.runway === topRunway);
        historyIsFresh = freshTraffic.length > 0;
      }
    }
  }

  // Determine result — priority:
  // 1. heading confirmation (aircraft on approach, <15nm, aligned with runway)
  // 2. very recent traffic (≤15min) — actual operations trump wind prediction
  // 3. wind + history agree
  // 4. fresh traffic (≤1hr)
  // 5. wind alone
  // 6. old history
  // 7. default (first runway)
  const confirmed = bestByHeading || null;
  let predicted;
  let confidence;

  if (confirmed) {
    predicted = confirmed;
    confidence = 'HIGH';
  } else if (bestByHistory && historyIsRecent) {
    // Very recent traffic — strongest signal after heading
    predicted = bestByHistory;
    confidence = 'TRAFFIC';
  } else if (bestByWind && bestByHistory && bestByWind.id === bestByHistory.id) {
    predicted = bestByWind;
    confidence = 'HIST+WIND';
  } else if (bestByHistory && historyIsFresh) {
    // Fresh traffic within 1 hour beats wind-only
    predicted = bestByHistory;
    confidence = 'TRAFFIC';
  } else if (bestByWind) {
    predicted = bestByWind;
    confidence = 'WIND';
  } else if (bestByHistory) {
    predicted = bestByHistory;
    confidence = 'HIST';
  } else {
    predicted = activeCandidates[0];
    confidence = 'LOW';
  }

  return {
    runway: predicted?.id || null,
    heading: predicted?.heading || null,
    confidence,
    headwind: bestByWind?.headwind || null,
    crosswind: bestByWind?.crosswind || null,
    windDir: windDir,
    windSpeed: windSpeed,
    historyCount: bestByHistory?.landingCount || 0,
    recentLandings: recentLandings.length,
  };
}

async function predictRunwaysForAll() {
  for (const icao of Object.keys(aircraftState)) {
    const state = aircraftState[icao];
    if (!state.destination || state.destination === 'N/A') continue;

    // Get weather for destination
    const wx = weatherCache[state.destination];
    let windDir = null, windSpeed = null;
    if (wx?.metar) {
      // Parse from raw METAR: look for wind group (dddssKT or dddssGssKT)
      const windMatch = wx.metar.match(/\b(\d{3}|VRB)(\d{2,3})(?:G\d{2,3})?KT\b/);
      if (windMatch) {
        windDir = windMatch[1] === 'VRB' ? 'VRB' : parseInt(windMatch[1]);
        windSpeed = parseInt(windMatch[2]);
      }
    }

    // Calculate distance to destination
    let distNm = null;
    if (state.lat && state.lon && state.dest_lat && state.dest_lon) {
      distNm = haversineNm(state.lat, state.lon, state.dest_lat, state.dest_lon);
    }

    const result = predictRunway(state.destination, windDir, windSpeed, state.heading, distNm, 'ARR');
    if (result) {
      state.predicted_runway = result.runway;
      state.runway_wind = `${result.windDir || '---'}°/${result.windSpeed || 0}kt`;
      state.runway_confidence = result.confidence;
      state.runway_headwind = result.headwind;
      state.runway_crosswind = result.crosswind;
      state.runway_history_count = result.historyCount;
      state.runway_recent_landings = result.recentLandings;
    }

    // ── Departure runway prediction ──
    // Only predict if not already locked in from a previous poll
    if (state.origin && state.origin !== 'N/A' && !state.dep_runway) {
      let depDistNm = null;
      if (state.lat && state.lon && state.origin_lat && state.origin_lon) {
        depDistNm = haversineNm(state.lat, state.lon, state.origin_lat, state.origin_lon);
      }

      // Primary: use aircraft's actual heading near origin to match runway
      // After takeoff, the aircraft heading ≈ runway heading
      if (state.heading != null && depDistNm != null && depDistNm < 30
          && state.altitude && state.altitude < 15000) {
        const runways = getRunways(state.origin);
        if (runways && runways.length > 0) {
          // Find the runway whose heading best matches the aircraft heading
          let bestRwy = null;
          let bestDiff = 360;
          runways.forEach(rw => {
            if (rw.le && rw.lh != null) {
              let diff = Math.abs(state.heading - rw.lh);
              if (diff > 180) diff = 360 - diff;
              if (diff < bestDiff) { bestDiff = diff; bestRwy = { id: rw.le, heading: rw.lh }; }
            }
            if (rw.he && rw.hh != null) {
              let diff = Math.abs(state.heading - rw.hh);
              if (diff > 180) diff = 360 - diff;
              if (diff < bestDiff) { bestDiff = diff; bestRwy = { id: rw.he, heading: rw.hh }; }
            }
          });

          if (bestRwy && bestDiff < 15) {
            const depWx = weatherCache[state.origin];
            let depWindStr = '';
            if (depWx?.metar) {
              const m = depWx.metar.match(/\b(\d{3}|VRB)(\d{2,3})(?:G\d{2,3})?KT\b/);
              if (m) depWindStr = `${m[1]}°/${m[2]}kt`;
            }
            state.dep_runway = bestRwy.id;
            state.dep_runway_wind = depWindStr || '';
            state.dep_runway_confidence = bestDiff < 10 ? 'HIGH' : 'TRACK';
            state.dep_runway_headwind = null;
            state.dep_runway_crosswind = null;
          }
        }
      }

      // Fallback: wind-based prediction only if still no dep_runway
      // and aircraft is far from origin (can't use track anymore)
      if (!state.dep_runway) {
        const depWx = weatherCache[state.origin];
        let depWindDir = null, depWindSpeed = null;
        if (depWx?.metar) {
          const depWindMatch = depWx.metar.match(/\b(\d{3}|VRB)(\d{2,3})(?:G\d{2,3})?KT\b/);
          if (depWindMatch) {
            depWindDir = depWindMatch[1] === 'VRB' ? 'VRB' : parseInt(depWindMatch[1]);
            depWindSpeed = parseInt(depWindMatch[2]);
          }
        }
        const depResult = predictRunway(state.origin, depWindDir, depWindSpeed, null, null, 'DEP');
        if (depResult) {
          state.dep_runway = depResult.runway;
          state.dep_runway_wind = `${depResult.windDir || '---'}°/${depResult.windSpeed || 0}kt`;
          state.dep_runway_confidence = depResult.confidence;
          state.dep_runway_headwind = depResult.headwind;
          state.dep_runway_crosswind = depResult.crosswind;
        }
      }
    }

    // ── Detect and record landings ──
    // If aircraft is on final approach (<3nm, <1500ft, heading aligned with a runway)
    if (result && result.confidence === 'HIGH' && distNm != null && distNm < 3
        && state.altitude && state.altitude < 1500 && !state.on_ground) {
      if (!state._landingRecorded) {
        state._landingRecorded = true;
        if (!runwayHistory[state.destination]) runwayHistory[state.destination] = [];
        // Only record once — deduplicate by checking last entry
        const lastArr = runwayHistory[state.destination];
        const lastEntry = lastArr.length > 0 ? lastArr[lastArr.length - 1] : null;
        if (lastEntry && lastEntry.aircraft === icao && Date.now() - lastEntry.ts < 120000) { continue; }
        runwayHistory[state.destination].push({
          runway: result.runway,
          type: 'ARR',
          ts: Date.now(),
          windDir: windDir,
          windSpeed: windSpeed,
          aircraft: icao,
        });
        if (runwayHistory[state.destination].length > 100) {
          runwayHistory[state.destination] = runwayHistory[state.destination].slice(-100);
        }
        saveRunwayHistory();
        console.log(`🛬 Landing recorded: ${state.registration || icao} → ${state.destination} RWY ${result.runway}`);
      }
    }

    // ── Detect and record takeoffs ──
    // If aircraft is near origin (<5nm, <3000ft, climbing >500fpm, gs>80kt, heading aligned)
    if (state.origin && state.origin !== 'N/A' && state.origin_lat && state.origin_lon
        && state.lat && state.lon && state.heading != null
        && state.altitude && state.altitude < 3000
        && state.vertical_rate && state.vertical_rate > 500
        && state.ground_speed && state.ground_speed > 80) {
      const distToOrigin = haversineNm(state.lat, state.lon, state.origin_lat, state.origin_lon);
      if (distToOrigin < 5 && !state._takeoffRecorded) {
        // Direct heading match to runway (don't use predictRunway — we want actual heading)
        const runways = getRunways(state.origin);
        if (runways && runways.length > 0) {
          let bestRwy = null;
          let bestDiff = 360;
          runways.forEach(rw => {
            if (rw.le && rw.lh != null) {
              let diff = Math.abs(state.heading - rw.lh);
              if (diff > 180) diff = 360 - diff;
              if (diff < bestDiff) { bestDiff = diff; bestRwy = rw.le; }
            }
            if (rw.he && rw.hh != null) {
              let diff = Math.abs(state.heading - rw.hh);
              if (diff > 180) diff = 360 - diff;
              if (diff < bestDiff) { bestDiff = diff; bestRwy = rw.he; }
            }
          });

          if (bestRwy && bestDiff < 15) {
            state._takeoffRecorded = true;
            // Also set dep_runway on the aircraft
            if (!state.dep_runway) {
              state.dep_runway = bestRwy;
              state.dep_runway_confidence = bestDiff < 10 ? 'HIGH' : 'TRACK';
            }
            // Record to history (dedup: skip if same aircraft + runway within 5 min)
            if (!runwayHistory[state.origin]) runwayHistory[state.origin] = [];
            const hist = runwayHistory[state.origin];
            const isDup = hist.some(h => h.aircraft === icao && h.runway === bestRwy && Date.now() - h.ts < 300000);
            if (!isDup) {
              hist.push({
                runway: bestRwy,
                type: 'DEP',
                ts: Date.now(),
                windDir, windSpeed,
                aircraft: icao,
              });
              if (hist.length > 100) runwayHistory[state.origin] = hist.slice(-100);
              saveRunwayHistory();
              console.log(`🛫 Takeoff recorded: ${state.registration || icao} ← ${state.origin} RWY ${bestRwy}`);
            }
          }
        }
      }
    }

    // If dep_runway still not set and aircraft is far from origin, use traffic history
    if (state.origin && state.origin !== 'N/A' && !state.dep_runway) {
      const depHistory = runwayHistory[state.origin] || [];
      const recentDeps = depHistory.filter(h => h.type === 'DEP' && Date.now() - h.ts < 2 * 60 * 60 * 1000);
      if (recentDeps.length > 0) {
        // Use most recent departure runway
        const lastDep = recentDeps[recentDeps.length - 1];
        state.dep_runway = lastDep.runway;
        state.dep_runway_confidence = 'TRAFFIC';
      }
    }
  }
}

// ── Geofence Polling ──
function haversineNm(lat1, lon1, lat2, lon2) {
  const R = 3440.065; // Earth radius in nautical miles
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function pollGeofence() {
  if (!geofence.enabled) return;
  if (pollGeofence._busy) return; // Skip if previous poll still running
  pollGeofence._busy = true;

  try {
    // Auto-discover airports on first geofence poll if not yet done
    if (geofenceAirports.length === 0) {
      geofenceAirports = findNearestAirports(geofence.lat, geofence.lon, geofence.radiusNm);
      if (geofenceAirports.length > 0) {
        console.log(`✈️ Geofence airports: ${geofenceAirports.map(a => `${a.icao}(${a.distNm}nm)`).join(', ')}`);
        for (const apt of geofenceAirports) {
          fetchWeather(apt.icao).catch(() => {});
          fetchNotamsForAirport(apt.icao).catch(() => {});
        }
      }
    }
    // ── Independent source caches (populated by their own timers) ──
    // Each source runs on its own schedule, pollGeofence just merges caches
    if (!pollGeofence._sourcesStarted) {
      pollGeofence._sourcesStarted = true;
      pollGeofence._caches = { apl: [], lol: [], fi: [], one: [], osky: [], fr24: [] };

      const fetchAdsb = async (name, url) => {
        try {
          const r = await fetchWithTimeout(url, 3000);
          if (r.ok) {
            const d = await r.json();
            pollGeofence._caches[name] = d?.ac || [];
          }
        } catch (e) {}
      };

      const fetchOpenSky = async () => {
        try {
          const latDeg = geofence.radiusNm / 60;
          const lonDeg = geofence.radiusNm / (60 * Math.cos(geofence.lat * Math.PI / 180));
          const url = `https://opensky-network.org/api/states/all?lamin=${geofence.lat - latDeg}&lomin=${geofence.lon - lonDeg}&lamax=${geofence.lat + latDeg}&lomax=${geofence.lon + lonDeg}`;
          const r = await fetchWithTimeout(url, 5000);
          if (r.ok) {
            const d = await r.json();
            if (d?.states) {
              pollGeofence._caches.osky = d.states.map(s => ({
                hex: s[0], flight: s[1]?.trim() || '',
                lat: s[6], lon: s[5],
                alt_baro: s[7] ? Math.round(s[7] * 3.281) : null,
                gs: s[9] ? Math.round(s[9] * 1.944) : null,
                track: s[10],
                baro_rate: s[11] ? Math.round(s[11] * 196.85) : null,
                on_ground: s[8], squawk: s[14],
              }));
            }
          }
        } catch (e) {}
      };

      const fetchFR24 = async () => {
        try {
          const latDeg = geofence.radiusNm / 60;
          const lonDeg = geofence.radiusNm / (60 * Math.cos(geofence.lat * Math.PI / 180));
          const url = `https://data-cloud.flightradar24.com/zones/fcgi/feed.js?bounds=${geofence.lat + latDeg},${geofence.lat - latDeg},${geofence.lon - lonDeg},${geofence.lon + lonDeg}&faa=1&satellite=1&mlat=1&adsb=1&air=1&gnd=1`;
          const r = await fetchWithTimeout(url, 3000);
          if (r.ok) {
            const d = await r.json();
            if (d) {
              const converted = [];
              for (const [key, val] of Object.entries(d)) {
                if (!Array.isArray(val) || val.length < 14) continue;
                converted.push({
                  hex: val[0]?.toLowerCase() || '',
                  lat: val[1], lon: val[2], track: val[3],
                  alt_baro: val[4], gs: val[5], squawk: val[6],
                  t: val[8], r: val[9],
                  flight: (val[13] || val[16] || '').trim(),
                });
              }
              pollGeofence._caches.fr24 = converted;
            }
          }
        } catch (e) {}
      };

      // Start independent timers — stagger ADS-B sources to avoid rate limits
      // Each source polls every 5s, but offset by ~1s so one source responds every ~1s
      const tick = (fn, ms) => { fn(); setInterval(fn, ms); };
      const stagger = (fn, ms, delay) => { setTimeout(() => tick(fn, ms), delay); };
      // Build URLs dynamically so they track geofence position changes
      const mkUrl = (base) => `${base}/${geofence.lat}/${geofence.lon}/${geofence.radiusNm}`;

      tick(() => fetchAdsb('apl', mkUrl('https://api.airplanes.live/v2/point')), 3000);
      stagger(() => fetchAdsb('lol', mkUrl('https://api.adsb.lol/v2/point')), 5000, 1000);
      stagger(() => fetchAdsb('fi', mkUrl('https://opendata.adsb.fi/api/v2/point')), 5000, 2000);
      stagger(() => fetchAdsb('one', mkUrl('https://api.adsb.one/v2/point')), 5000, 3000);
      stagger(fetchOpenSky, 10000, 500);
      stagger(fetchFR24, 5000, 4000);
      console.log('📡 Source fetchers started (apl:3s, lol/fi/one:5s staggered, osky:10s, fr24:5s)');
    }

    // Instant merge — no network wait, just read caches
    const caches = pollGeofence._caches || { apl: [], lol: [], fi: [], one: [], osky: [], fr24: [] };
    const results = [caches.apl, caches.lol, caches.fi, caches.one, caches.osky, caches.fr24];

    // Merge all results by hex — first valid position wins, enrich metadata only
    const seenHex = new Map();
    for (const list of results) {
      for (const ac of list) {
        const hex = (ac.hex || '').toLowerCase();
        if (!hex) continue;
        const existing = seenHex.get(hex);
        if (!existing) {
          seenHex.set(hex, { ...ac });
        } else {
          // Enrich metadata only — don't override position
          if (ac.r && !existing.r) existing.r = ac.r;
          if (ac.flight && !existing.flight) existing.flight = ac.flight;
          if (ac.t && !existing.t) existing.t = ac.t;
          // Only take position if existing has none
          if (existing.lat == null && ac.lat != null) {
            existing.lat = ac.lat;
            existing.lon = ac.lon;
            existing.alt_baro = ac.alt_baro;
            existing.gs = ac.gs;
            existing.track = ac.track;
            existing.baro_rate = ac.baro_rate;
          }
        }
      }
    }


    const acList = [...seenHex.values()];
    const srcCounts = results.map(r => r.length);
    if (acList.length > 0 && !pollGeofence._loggedMerge) {
      pollGeofence._loggedMerge = true;
      console.log(`📡 Geofence: ${acList.length} aircraft from 6 sources (apl:${srcCounts[0]} lol:${srcCounts[1]} fi:${srcCounts[2]} one:${srcCounts[3]} osky:${srcCounts[4]} fr24:${srcCounts[5]})`);
    }

    const currentIcaos = new Set();
    const allNearby = []; // All aircraft currently in radius
    nearbyCallsigns = {}; // Reset each poll cycle

    for (const ac of acList) {
      const hex = (ac.hex || '').toLowerCase();
      if (!hex) continue;
      // Skip aircraft with no valid position
      if (ac.lat == null || ac.lon == null) continue;
      // Skip truly parked aircraft (on ground with no speed)
      // Don't filter all on_ground — APIs disagree causing flickering
      const isParked = (ac.on_ground === true || ac.alt_baro === 'ground') && (!ac.gs || ac.gs < 5);
      if (isParked) continue;
      // Skip aircraft outside actual circular radius (APIs use bounding boxes)
      const distToCenter = haversineNm(geofence.lat, geofence.lon, ac.lat, ac.lon);
      if (distToCenter > geofence.radiusNm) continue;
      currentIcaos.add(hex);

      // Prefer adsb.lol registration, then airplanes.live, then hex
      const bestReg = ac.r || null;
      const reg = bestReg || hex.toUpperCase();
      const callsign = (ac.flight || '').trim();
      const alt = ac.alt_baro === 'ground' ? 0 : (ac.alt_baro || 0);
      const vr = ac.baro_rate || ac.geom_rate || 0;

      // Collect for bulk update — include route from cache if available
      const route = callsign ? routeCache[callsign] : null;
      allNearby.push({
        hex, reg: bestReg, callsign,
        lat: ac.lat || null, lon: ac.lon || null,
        alt, gs: ac.gs || null, vr,
        heading: ac.track || ac.true_heading || null,
        origin: route?.origin || null,
        destination: route?.destination || null,
      });

      // Feed callsign to transcriber
      if (callsign) {
        nearbyCallsigns[hex] = { callsign };
        // Queue route lookup for nearby aircraft without cached routes
        if (!routeCache[callsign]) {
          if (!pollGeofence._routeQueue) pollGeofence._routeQueue = [];
          pollGeofence._routeQueue.push(callsign);
        }
      }

      // ── Record landings/takeoffs from geofence aircraft ──
      const heading = ac.track || ac.true_heading;
      if (heading != null && geofenceAirports.length > 0) {
        for (const apt of geofenceAirports) {
          const distToApt = haversineNm(ac.lat, ac.lon, apt.lat, apt.lon);
          const rwys = getRunways(apt.icao);
          if (!rwys || rwys.length === 0) continue;

          // Landing: <2nm from airport, <1500ft, descending >500fpm, gs>80kt, heading within 10°
          const gsKts = ac.gs || 0;
          if (distToApt < 2 && alt > 0 && alt < 1500 && vr < -500 && gsKts > 80) {
            let bestRwy = null, bestDiff = 360;
            rwys.forEach(rw => {
              for (const [id, hdg] of [[rw.le, rw.lh], [rw.he, rw.hh]]) {
                if (!id || hdg == null) continue;
                let diff = Math.abs(heading - hdg);
                if (diff > 180) diff = 360 - diff;
                if (diff < bestDiff) { bestDiff = diff; bestRwy = id; }
              }
            });
            if (bestRwy && bestDiff < 10) {
              const key = `${hex}_${apt.icao}_ARR`;
              if (!pollGeofence._recordedOps) pollGeofence._recordedOps = new Set();
              if (!pollGeofence._recordedOps.has(key)) {
                pollGeofence._recordedOps.add(key);
                if (!runwayHistory[apt.icao]) runwayHistory[apt.icao] = [];
                const hist = runwayHistory[apt.icao];
                const isDup = hist.some(h => h.aircraft === hex && h.runway === bestRwy && Date.now() - h.ts < 300000);
                if (!isDup) {
                  hist.push({ runway: bestRwy, type: 'ARR', ts: Date.now(), aircraft: hex });
                  if (hist.length > 100) runwayHistory[apt.icao] = hist.slice(-100);
                  saveRunwayHistory();
                  console.log(`🛬 Geofence landing: ${callsign || hex} → ${apt.icao} RWY ${bestRwy} (${Math.round(distToApt*10)/10}nm, ${alt}ft, ${vr}fpm, hdg ${Math.round(heading)}°, diff ${Math.round(bestDiff)}°)`);
                }
              }
            }
          }

          // Takeoff: <5nm from airport, <3000ft, climbing >500fpm, gs>60kt, heading within 15°
          if (distToApt < 5 && alt > 0 && alt < 3000 && vr > 500 && gsKts > 60) {
            let bestRwy = null, bestDiff = 360;
            rwys.forEach(rw => {
              for (const [id, hdg] of [[rw.le, rw.lh], [rw.he, rw.hh]]) {
                if (!id || hdg == null) continue;
                let diff = Math.abs(heading - hdg);
                if (diff > 180) diff = 360 - diff;
                if (diff < bestDiff) { bestDiff = diff; bestRwy = id; }
              }
            });
            if (bestRwy && bestDiff < 15) {
              const key = `${hex}_${apt.icao}_DEP`;
              if (!pollGeofence._recordedOps) pollGeofence._recordedOps = new Set();
              if (!pollGeofence._recordedOps.has(key)) {
                pollGeofence._recordedOps.add(key);
                if (!runwayHistory[apt.icao]) runwayHistory[apt.icao] = [];
                const hist = runwayHistory[apt.icao];
                const isDup = hist.some(h => h.aircraft === hex && h.runway === bestRwy && Date.now() - h.ts < 300000);
                if (!isDup) {
                  hist.push({ runway: bestRwy, type: 'DEP', ts: Date.now(), aircraft: hex });
                  if (hist.length > 100) runwayHistory[apt.icao] = hist.slice(-100);
                  saveRunwayHistory();
                  console.log(`🛫 Geofence takeoff: ${callsign || hex} ← ${apt.icao} RWY ${bestRwy} (${Math.round(distToApt*10)/10}nm, ${alt}ft, +${vr}fpm)`);
                }
              }
            }
          }
        }
      }

      if (!geofence.seenIcaos.has(hex)) {
        // New aircraft entered the radius
        geofence.seenIcaos.add(hex);

        const distance = (ac.lat != null && ac.lon != null)
          ? haversineNm(geofence.lat, geofence.lon, ac.lat, ac.lon)
          : 0;

        // Telegram notification
        await sendMessage(
          `✈️ <b>${reg}</b>${callsign ? ' (' + callsign + ')' : ''} entered radius\n📍 ${alt}ft, ${Math.round(distance)}nm from center`
        );

        // WebSocket alert (new entry toast)
        const alertMsg = JSON.stringify({
          type: 'geofence_alert',
          aircraft: {
            hex, reg: bestReg, callsign,
            lat: ac.lat || null, lon: ac.lon || null,
            alt, gs: ac.gs || null, vr,
          },
        });
        for (const ws of wsClients) {
          if (ws.readyState === WebSocket.OPEN) {
            try { ws.send(alertMsg); } catch (e) {}
          }
        }
      }
    }

    // Broadcast ALL nearby aircraft positions (for map marker updates)
    if (allNearby.length > 0) {
      const updateMsg = JSON.stringify({
        type: 'geofence_update',
        aircraft: allNearby,
      });
      for (const ws of wsClients) {
        if (ws.readyState === WebSocket.OPEN) {
          try { ws.send(updateMsg); } catch (e) {}
        }
      }
    }

    // Remove aircraft that left the area
    for (const icao of geofence.seenIcaos) {
      if (!currentIcaos.has(icao)) {
        geofence.seenIcaos.delete(icao);
      }
    }
    // Lookup routes for nearby aircraft (max 2 per cycle via adsbdb)
    const rq = pollGeofence._routeQueue || [];
    const batch = [...new Set(rq)].filter(cs => !routeCache[cs]).slice(0, 2);
    pollGeofence._routeQueue = [];
    for (const cs of batch) {
      try {
        const r = await fetchWithTimeout(`https://api.adsbdb.com/v0/callsign/${cs}`, 5000);
        if (r.ok) {
          const d = await r.json();
          const fp = d?.response?.flightroute;
          if (fp?.origin?.icao_code) {
            routeCache[cs] = {
              origin: fp.origin.icao_code,
              destination: fp.destination?.icao_code || 'N/A',
              origin_city: fp.origin.municipality || '',
              dest_city: fp.destination?.municipality || '',
              _ts: Date.now(), _src: 'adsbdb',
            };
          } else {
            routeCache[cs] = { origin: 'N/A', destination: 'N/A', _ts: Date.now() };
          }
        }
      } catch (e) {}
    }
  } catch (e) {
    console.error('Geofence poll error:', e.message);
  } finally {
    pollGeofence._busy = false;
  }
}

// ── WebSocket ──
const wsClients = new Set();

function broadcastState() {
  // Collect cached weather for airports referenced by active aircraft
  const weather = {};
  for (const icao of Object.keys(aircraftState)) {
    const state = aircraftState[icao];
    if (state.origin && state.origin !== 'N/A' && weatherCache[state.origin]) {
      const w = weatherCache[state.origin];
      weather[state.origin] = { metar: w.metar, taf: w.taf, parsed: w.parsed || null };
    }
    if (state.destination && state.destination !== 'N/A' && weatherCache[state.destination]) {
      const w = weatherCache[state.destination];
      weather[state.destination] = { metar: w.metar, taf: w.taf, parsed: w.parsed || null };
    }
  }
  // Also include weather for favorite airports
  for (const code of favoriteAirports) {
    if (weatherCache[code]) {
      const w = weatherCache[code];
      weather[code] = { metar: w.metar, taf: w.taf, parsed: w.parsed || null };
    }
  }

  // Collect coords for favorite airports
  const favAirportCoords = {};
  for (const code of favoriteAirports) {
    const cached = airportCoordCache[code];
    if (cached && cached.lat) {
      favAirportCoords[code] = { lat: cached.lat, lon: cached.lon, city: cached.city || '' };
    }
  }

  const msg = JSON.stringify({
    type: 'update',
    aircraft: aircraftState,
    trails: trailData,
    watchlist: watchlist,
    geofence: {
      enabled: geofence.enabled,
      lat: geofence.lat,
      lon: geofence.lon,
      radiusNm: geofence.radiusNm,
    },
    weather: Object.keys(weather).length > 0 ? weather : undefined,
    runwayHistory: runwayHistory,
    telegramEnabled: telegramEnabled,
    favoriteAirports: favoriteAirports,
    favAirportCoords: favAirportCoords,
    ts: Date.now(),
  });
  for (const ws of wsClients) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(msg); } catch (e) {}
    }
  }
}

// ── Static File Server ──
const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res) {
  let filePath = req.url === '/' ? '/index.html' : req.url;
  // Strip query strings
  filePath = filePath.split('?')[0];
  // Security: prevent directory traversal
  filePath = path.normalize(filePath).replace(/^(\.\.[\/\\])+/, '');
  const fullPath = path.join(WEB_DIR, filePath);

  // Ensure we stay within WEB_DIR
  if (!fullPath.startsWith(WEB_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(fullPath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

// ── HTTP API ──
const httpServer = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // API endpoints
  if (req.url.startsWith('/api/')) {
    if (req.method === 'POST' && req.url === '/api/sync') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (Array.isArray(data)) {
            const extIcaos = new Set(data.map(e => (e.icao24 || '').toLowerCase()).filter(Boolean));
            const serverIcaos = new Set(watchlist.map(w => (w.icao24 || '').toLowerCase()));

            // 1. Add new aircraft from extension → server (skip removed ones)
            let added = 0;
            data.forEach(entry => {
              const icao = (entry.icao24 || '').toLowerCase();
              if (icao && !serverIcaos.has(icao) && !removedIcaos.has(icao)) {
                watchlist.push(entry);
                serverIcaos.add(icao);
                added++;
              }
            });
            if (added > 0) saveData();
            console.log(`📋 Watchlist synced: ${watchlist.length} aircraft (+${added} new from extension)`);

            // 3. Tell extension which ICAOs were removed server-side so it can remove them too
            const removedServerSide = [...removedIcaos];

            broadcastState();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              ok: true,
              count: watchlist.length,
              removed: removedServerSide, // ICAOs the extension should remove
            }));
          } else {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Expected array' }));
          }
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
        }
      });
      return;
    }

    if (req.method === 'GET' && req.url === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ watchlist: watchlist.length, states: aircraftState }));
      return;
    }

    if (req.method === 'GET' && req.url.startsWith('/api/atis/')) {
      const icao = req.url.split('/').pop().toUpperCase();
      try {
        const atisRes = await fetch(`https://atis.guru/atis/${icao}`);
        const html = await atisRes.text();
        
        const extract = (label) => {
          const regex = new RegExp(`${label}[\\s\\S]*?<div class="atis">([\\s\\S]*?)<\\/div>`, 'i');
          const match = html.match(regex);
          return match ? match[1].replace(/&#xA;/g, '\n').replace(/&#xD;/g, '\r').replace(/&#x9;/g, '  ').replace(/<[^>]*>/g, '').trim() : null;
        };

        const arr = extract('Arrival ATIS');
        const dep = extract('Departure ATIS');
        let generic = extract('D-ATIS for');
        
        if (!arr && !dep && !generic) {
          const genericMatch = html.match(/<div class="atis">([\s\S]*?)<\/div>/i);
          if (genericMatch) {
            generic = genericMatch[1].replace(/&#xA;/g, '\n').replace(/&#xD;/g, '\r').replace(/&#x9;/g, '  ').replace(/<[^>]*>/g, '').trim();
          }
        }

        if (!arr && !dep && !generic) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No ATIS found for ' + icao }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ icao, arr, dep, combined: generic }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/api/atis/summarize') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const { text } = JSON.parse(body);
          if (!process.env.GROQ_API_KEY) {
             res.writeHead(400, { 'Content-Type': 'application/json' });
             res.end(JSON.stringify({ error: 'Groq API key not configured.' }));
             return;
          }
          
          const prompt = `You are an expert aviation AI. Summarize the following ATIS into a short, easy-to-read list of the most critical actionable items for a pilot. Use bullet points. Focus ONLY on:
- Runways in use (Arrival/Departure)
- Wind & Visibility
- Altimeter (QNH)
- Any critical hazards or notices (e.g., closures, windshear)

CRITICAL RULES:
1. Do NOT confuse Taxiways (TWY or T) with Runways (RWY or R). If it says "TWY T", that is Taxiway Tango, NOT Runway Tango.
2. Keep it extremely brief with no conversational filler.

ATIS:
${text}`;

          const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              model: 'llama-3.1-8b-instant',
              messages: [{ role: 'user', content: prompt }],
              temperature: 0.2,
            })
          });
          
          const groqData = await groqRes.json();
          if (!groqRes.ok) throw new Error(groqData.error?.message || 'Groq API error');
          
          const summary = groqData.choices[0].message.content.trim();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ summary }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    if (req.method === 'GET' && req.url === '/api/watchlist') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(watchlist));
      return;
    }

    if (req.method === 'GET' && req.url === '/api/aircraft') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        aircraft: aircraftState,
        trails: trailData,
        watchlist: watchlist,
        ts: Date.now(),
      }));
      return;
    }

    if (req.method === 'POST' && req.url === '/api/watchlist/add') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const { input } = JSON.parse(body);
          const result = await handleAdd(null, input);
          res.writeHead(result?.ok ? 200 : 404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result || { ok: false }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }

    if (req.method === 'GET' && req.url.startsWith('/api/atc/')) {
      const mount = req.url.replace('/api/atc/', '').split('?')[0];
      if (!mount || mount.includes('..') || mount.includes('/')) {
        res.writeHead(400); res.end('Bad mount'); return;
      }
      try {
        const streamUrl = `http://d.liveatc.net/${mount}`;
        const ac = new AbortController();
        const connTimeout = setTimeout(() => ac.abort(), 10000);
        const upstream = await fetch(streamUrl, {
          headers: { 'User-Agent': 'iTunes/12.9', 'Icy-MetaData': '0' },
          signal: ac.signal,
        });
        clearTimeout(connTimeout); // Connection established, stop timeout
        if (!upstream.ok) {
          res.writeHead(upstream.status); res.end('Stream unavailable'); return;
        }
        res.writeHead(200, {
          'Content-Type': 'audio/mpeg',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
        const reader = upstream.body.getReader();
        const pump = async () => {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done || res.destroyed) break;
              // Tee audio to transcriber
              atcTranscriber.feedAudio(value);
              if (!res.write(value)) {
                await new Promise(r => res.once('drain', r));
              }
            }
          } catch (e) { /* stream ended or aborted */ }
          res.end();
        };
        pump();
        req.on('close', () => {
          try { ac.abort(); } catch (e) {}
          try { reader.cancel(); } catch (e) {}
        });
      } catch (e) {
        if (!res.headersSent) {
          res.writeHead(502); res.end('Stream error: ' + e.message);
        }
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/api/watchlist/remove') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const { input } = JSON.parse(body);
          const result = await handleRemove(null, input);
          res.writeHead(result?.ok ? 200 : 404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result || { ok: false }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/poll') {
      // Force an immediate poll
      pollAircraft().catch(e => console.error('Force poll error:', e.message));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: 'Poll triggered' }));
      return;
    }

    if (req.method === 'GET' && req.url === '/api/settings') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ pollInterval: POLL_INTERVAL / 1000 }));
      return;
    }

    if (req.method === 'POST' && req.url === '/api/settings') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const settings = JSON.parse(body);
          if (settings.pollInterval && settings.pollInterval >= 1) {
            const newInterval = settings.pollInterval * 1000;
            if (pollTimer) clearInterval(pollTimer);
            pollTimer = setInterval(async () => {
              try { await pollAircraft(); } catch (e) { console.error('Poll error:', e.message); }
              try { await pollGeofence(); } catch (e) { console.error('Geofence poll error:', e.message); }
            }, newInterval);
            pollTimer._currentInterval = newInterval;
            console.log(`⚙️ Poll interval changed to ${settings.pollInterval}s${newInterval < 5000 ? ' (fast round-robin mode)' : ''}`);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }

    // GET /api/vapidPublicKey
    if (req.method === 'GET' && req.url === '/api/vapidPublicKey') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ publicKey: process.env.VAPID_PUBLIC_KEY || null }));
      return;
    }

    // GET /api/test-push
    if (req.method === 'GET' && req.url === '/api/test-push') {
      try {
        if (!db) throw new Error('Database not connected');
        const subs = await db.collection('subscriptions').find({}).toArray();
        if (subs.length === 0) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, message: 'No subscriptions found in MongoDB. Please click Enable in the app again.' }));
          return;
        }
        
        let successCount = 0;
        let errors = [];
        for (const sub of subs) {
          try {
            await webpush.sendNotification(sub, JSON.stringify({ title: 'Test Alert', body: 'Web Push is working perfectly!' }));
            successCount++;
          } catch (e) {
            errors.push(e.message);
          }
        }
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, subsFound: subs.length, successCount, errors }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // POST /api/notifications/subscribe
    if (req.method === 'POST' && req.url === '/api/notifications/subscribe') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', async () => {
        try {
          if (!db) throw new Error('MongoDB not connected');
          const subscription = JSON.parse(body);
          await db.collection('subscriptions').updateOne(
            { endpoint: subscription.endpoint },
            { $set: subscription },
            { upsert: true }
          );
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // POST /api/notifications/unsubscribe
    if (req.method === 'POST' && req.url === '/api/notifications/unsubscribe') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', async () => {
        try {
          if (!db) throw new Error('MongoDB not connected');
          const { endpoint } = JSON.parse(body);
          if (endpoint) {
            await db.collection('subscriptions').deleteOne({ endpoint });
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // GET /api/telegram — current state
    if (req.method === 'GET' && req.url === '/api/telegram') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ enabled: telegramEnabled }));
      return;
    }

    // POST /api/telegram — toggle
    if (req.method === 'POST' && req.url === '/api/telegram') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const { enabled } = JSON.parse(body);
          if (typeof enabled === 'boolean') {
            telegramEnabled = enabled;
            saveData();
            console.log(`📱 Telegram notifications: ${enabled ? 'ON' : 'OFF'}`);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, enabled: telegramEnabled }));
        } catch (e) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
      return;
    }

    if (req.method === 'GET' && req.url === '/api/geofence') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        enabled: geofence.enabled,
        lat: geofence.lat,
        lon: geofence.lon,
        radiusNm: geofence.radiusNm,
      }));
      return;
    }

    if (req.method === 'POST' && req.url === '/api/geofence') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          const wasEnabled = geofence.enabled;
          if (data.enabled !== undefined) geofence.enabled = !!data.enabled;
          if (data.lat !== undefined) geofence.lat = Number(data.lat);
          if (data.lon !== undefined) geofence.lon = Number(data.lon);
          if (data.radiusNm !== undefined) geofence.radiusNm = Number(data.radiusNm);
          // Clear seenIcaos when enabling
          if (geofence.enabled && !wasEnabled) {
            geofence.seenIcaos = new Set();
          }
          // Auto-discover airports in geofence and fetch METAR/NOTAM
          if (geofence.enabled) {
            geofenceAirports = findNearestAirports(geofence.lat, geofence.lon, geofence.radiusNm);
            if (geofenceAirports.length > 0) {
              console.log(`✈️ Geofence airports: ${geofenceAirports.map(a => `${a.icao}(${a.distNm}nm)`).join(', ')}`);
              // Fetch METAR + NOTAM for each
              for (const apt of geofenceAirports) {
                fetchWeather(apt.icao).catch(() => {});
                fetchNotamsForAirport(apt.icao).catch(() => {});
              }
            }
          }
          saveData();
          broadcastState();
          // Reset source caches so fresh data flows immediately
          pollGeofence._loggedMerge = false;
          if (pollGeofence._caches) {
            pollGeofence._caches = { apl: [], lol: [], fi: [], one: [], osky: [], fr24: [] };
          }
          console.log(`🔔 Geofence updated: ${geofence.enabled ? 'ON' : 'OFF'} — ${geofence.lat},${geofence.lon} r=${geofence.radiusNm}nm`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }

    // GET /api/favorites
    if (req.method === 'GET' && req.url === '/api/favorites') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ favorites: favoriteAirports }));
      return;
    }

    // POST /api/favorites — { add: 'LLBG' } or { remove: 'LLBG' }
    if (req.method === 'POST' && req.url === '/api/favorites') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const data = JSON.parse(body);
          if (data.add) {
            const code = data.add.toUpperCase().trim();
            if (code && !favoriteAirports.includes(code)) {
              favoriteAirports.push(code);
              // Pre-resolve coords and weather
              const coords = await lookupAirportCoords(code);
              fetchWeather(code).catch(() => {});
              saveData();
              broadcastState();
              console.log(`⭐ Favorite airport added: ${code}`);
            }
          }
          if (data.remove) {
            const code = data.remove.toUpperCase().trim();
            favoriteAirports = favoriteAirports.filter(c => c !== code);
            saveData();
            broadcastState();
            console.log(`⭐ Favorite airport removed: ${code}`);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, favorites: favoriteAirports }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }

    // GET /api/weather/:icao
    if (req.method === 'GET' && req.url.match(/^\/api\/weather\/[A-Za-z0-9]+/)) {
      const icaoCode = req.url.split('/')[3].split('?')[0].toUpperCase();
      try {
        const data = await fetchWeather(icaoCode, true); // always force-refresh
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data ? { metar: data.metar, taf: data.taf, parsed: data.parsed || null } : { metar: null, taf: null, parsed: null }));
        broadcastState(); // push fresh weather to all clients
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Weather fetch failed' }));
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  // Static files (web frontend)
  serveStatic(req, res);
});

// ── Main ──
async function main() {
  console.log('🤖 Aircraft Alert Server starting...');
  console.log(`📡 Polling every ${POLL_INTERVAL / 1000}s`);
  console.log(`🌐 Web UI + API on port ${PORT}`);

  httpServer.listen(PORT, () => {
    console.log(`✅ Server ready at http://localhost:${PORT}`);
  });

  // WebSocket server — shares HTTP server
  const wss = new WebSocket.Server({ server: httpServer });
  wss.on('connection', (ws) => {
    wsClients.add(ws);
    console.log(`🔌 Web client connected (${wsClients.size} total)`);
    // Send current state immediately
    broadcastState();
    // Force-refresh all cached weather on page load
    (async () => {
      const airports = new Set();
      for (const apt of geofenceAirports) airports.add(apt.icao);
      for (const code of favoriteAirports) airports.add(code);
      for (const state of Object.values(aircraftState)) {
        if (state.origin && state.origin !== 'N/A') airports.add(state.origin);
        if (state.destination && state.destination !== 'N/A') airports.add(state.destination);
      }
      let refreshed = 0;
      for (const icao of airports) {
        await fetchWeather(icao, true).catch(() => {});
        refreshed++;
      }
      if (refreshed > 0) {
        console.log(`🌦️ Weather refreshed for ${refreshed} airports`);
        broadcastState(); // re-send with fresh weather
      }
    })();
    ws.on('close', () => {
      wsClients.delete(ws);
      console.log(`🔌 Web client disconnected (${wsClients.size} total)`);
    });
  });

  // Telegram command polling loop
  setInterval(pollTelegram, 2000);

  // ADS-B polling loop — watchlist
  pollTimer = setInterval(async () => {
    try {
      await pollAircraft();
    } catch (e) {
      console.error('Poll error:', e.message);
    }
  }, POLL_INTERVAL);

  // Geofence polling — independent fast loop (1s)
  setInterval(async () => {
    try {
      await pollGeofence();
    } catch (e) {
      console.error('Geofence poll error:', e.message);
    }
  }, 1000);

  // Initial poll after 3 seconds
  setTimeout(async () => {
    // Resolve favorite airport coords first
    for (const code of favoriteAirports) {
      await lookupAirportCoords(code);
      fetchWeather(code).catch(() => {});
    }
    if (favoriteAirports.length > 0) broadcastState();

    pollAircraft().catch(e => console.error('Initial poll error:', e.message));
    pollGeofence().catch(e => console.error('Initial geofence poll error:', e.message));
  }, 3000);

  if (!CHAT_ID) {
    console.log('\n💬 Send /start to your bot on Telegram to connect!\n');
  }

  // ATC transcription — disabled for now (re-enable when quality improves)
  // atcTranscriber.init().catch(e => console.error('Whisper init error:', e.message));
  // setInterval(async () => {
  //   try {
  //     const result = await atcTranscriber.tick(aircraftState, nearbyCallsigns);
  //     if (result && result.text) {
  //       const msg = JSON.stringify({
  //         type: 'atc_transcript',
  //         text: result.text,
  //         callsigns: result.callsigns,
  //         timestamp: result.timestamp,
  //       });
  //       for (const ws of wsClients) {
  //         if (ws.readyState === WebSocket.OPEN) {
  //           try { ws.send(msg); } catch (e) {}
  //         }
  //       }
  //     }
  //   } catch (e) {}
  // }, 2000);
  // ── Memory cleanup — every 2 minutes ──
  setInterval(() => {
    // Clean trail data for aircraft no longer tracked
    const activeIcaos = new Set(Object.keys(aircraftState));
    let trailsCleaned = 0;
    for (const icao of Object.keys(trailData)) {
      if (!activeIcaos.has(icao)) {
        delete trailData[icao];
        trailsCleaned++;
      }
    }

    // Cap _recordedOps (geofence landing/takeoff dedup) — keep last 200
    if (pollGeofence._recordedOps && pollGeofence._recordedOps.size > 200) {
      const arr = [...pollGeofence._recordedOps];
      pollGeofence._recordedOps = new Set(arr.slice(-100));
    }

    // Cap seenIcaos to prevent unbounded growth
    if (geofence.seenIcaos && geofence.seenIcaos.size > 500) {
      const arr = [...geofence.seenIcaos];
      geofence.seenIcaos = new Set(arr.slice(-200));
    }

    // Clean stale route cache entries (>1h) and cap total size
    const routeStale = Date.now() - 1 * 60 * 60 * 1000;
    let routesCleaned = 0;
    for (const key of Object.keys(routeCache)) {
      if (routeCache[key]._ts && routeCache[key]._ts < routeStale) {
        delete routeCache[key];
        routesCleaned++;
      }
    }
    // Hard cap at 500 entries — evict oldest
    const routeKeys = Object.keys(routeCache);
    if (routeKeys.length > 500) {
      const sorted = routeKeys.sort((a, b) => (routeCache[a]._ts || 0) - (routeCache[b]._ts || 0));
      const toRemove = sorted.slice(0, sorted.length - 300);
      toRemove.forEach(k => { delete routeCache[k]; routesCleaned++; });
    }

    // Clean nearbyCallsigns — reset each cycle
    nearbyCallsigns = {};

    if (trailsCleaned > 0 || routesCleaned > 0) {
      console.log(`🧹 Memory cleanup: ${trailsCleaned} trails, ${routesCleaned} routes purged`);
    }

    // Clean speedHistory for non-active aircraft
    for (const icao of Object.keys(speedHistory)) {
      if (!activeIcaos.has(icao)) delete speedHistory[icao];
    }

    // Clean lastSeenMap — remove entries for aircraft no longer in watchlist
    const watchlistIcaos = new Set(watchlist.map(w => (w.icao24 || '').toLowerCase()));
    for (const icao of Object.keys(lastSeenMap)) {
      if (!watchlistIcaos.has(icao)) delete lastSeenMap[icao];
    }

    // Force GC if exposed
    if (global.gc) { try { global.gc(); } catch (_) {} }
  }, 2 * 60 * 1000);
}

main();
