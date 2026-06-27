// ============================================================
//  Aircraft Tracker — app.js
// ============================================================

(function () {
  'use strict';

  // ---- State ----
  const aircraftData = {};   // keyed by icao24
  const airportMarkers = {}; // keyed by ICAO code
  const nearbyAircraft = {}; // keyed by icao — geofence detections
  const weatherData = {};    // keyed by ICAO airport code → { metar, taf }

  // Global weather refresh for popup buttons
  window._refreshWeather = async function (icao) {
    try {
      const btn = document.querySelector('.wx-refresh-btn');
      if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
      const res = await fetch(`${API_BASE}/api/weather/${icao}`);
      if (res.ok) {
        const data = await res.json();
        weatherData[icao] = data;
        // Server broadcasts updated state — popup will rebuild on next cycle
        if (btn) { btn.textContent = '✅'; setTimeout(() => { btn.textContent = '🔄'; btn.disabled = false; }, 1500); }
      } else {
        if (btn) { btn.textContent = '❌'; setTimeout(() => { btn.textContent = '🔄'; btn.disabled = false; }, 2000); }
      }
    } catch (e) {
      const btn = document.querySelector('.wx-refresh-btn');
      if (btn) { btn.textContent = '❌'; setTimeout(() => { btn.textContent = '🔄'; btn.disabled = false; }, 2000); }
    }
  };
  let runwayHistoryData = {};  // keyed by ICAO airport code → [{ runway, ts, windDir, windSpeed }]
  let favoriteAirports = [];   // ICAO codes from server
  let favAirportCoords = {};   // ICAO → { lat, lon, city }
  let activeIcao = null;     // currently selected
  let map, ws;
  let reconnectTimer = null;
  let firstUpdate = true;    // fit bounds only on first update
  let gfPersistChecked = false; // one-shot: auto-resume check done

  // ---- DOM refs ----
  const $map          = document.getElementById('map');
  const $sidebar      = document.getElementById('sidebar');
  const $toggle       = document.getElementById('sidebar-toggle');
  const $close        = document.getElementById('sidebar-close');
  const $list         = document.getElementById('aircraft-list');
  const $empty        = document.getElementById('empty-state');
  const $addInput     = document.getElementById('add-input');
  const $addBtn       = document.getElementById('add-btn');
  const $conn         = document.getElementById('conn-status');
  const $connLabel    = $conn.querySelector('.conn-label');
  const $statTotal    = document.getElementById('stat-total');
  const $statAirborne = document.getElementById('stat-airborne');
  const $statGround   = document.getElementById('stat-ground');

  // ---- Constants ----
  const isSecure = location.protocol === 'https:';
  const wsProtocol = isSecure ? 'wss:' : 'ws:';
  const httpProtocol = isSecure ? 'https:' : 'http:';
  const portStr = location.port ? `:${location.port}` : '';
  const WS_URL       = `${wsProtocol}//${location.hostname || 'localhost'}${portStr}`;
  const API_BASE     = `${httpProtocol}//${location.hostname || 'localhost'}${portStr}`;
  const TRAIL_MAX    = 200;
  const RECONNECT_MS = 5000;

  // ============================================================
  //  HELPERS
  // ============================================================

  function formatAltitude(alt) {
    if (alt == null || alt === '') return '—';
    return Number(alt).toLocaleString() + ' ft';
  }

  function formatSpeed(gs) {
    if (gs == null || gs === '') return '—';
    return Math.round(Number(gs)).toLocaleString() + ' kts';
  }

  function getRelativeTime(epochSec) {
    if (!epochSec) return '—';
    const diff = Math.floor(Date.now() / 1000 - epochSec);
    if (diff < 0)  return 'now';
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    const days = Math.floor(diff / 86400);
    if (days < 7) return `${days}d ago`;
    if (days < 30) { const w = Math.floor(days / 7); return `${w}w ago`; }
    if (days < 365) { const m = Math.floor(days / 30); return `${m}mo ago`; }
    const y = Math.floor(days / 365);
    const remM = Math.floor((days % 365) / 30);
    return remM > 0 ? `${y}y ${remM}mo ago` : `${y}y ago`;
  }

  function formatETA(eta) {
    if (!eta) return '—';
    const now = Date.now() / 1000;
    const rem = Math.max(0, eta - now);
    const h = Math.floor(rem / 3600);
    const m = Math.floor((rem % 3600) / 60);
    const arrival = new Date(eta * 1000);
    const hh = String(arrival.getHours()).padStart(2, '0');
    const mm = String(arrival.getMinutes()).padStart(2, '0');
    if (h > 0) return `~${h}h${m}m (${hh}:${mm})`;
    return `~${m}m (${hh}:${mm})`;
  }

  function haversineNm(lat1, lon1, lat2, lon2) {
    const R = 3440.065; // earth radius in NM
    const toRad = (d) => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function getStatus(ac) {
    // Server marks aircraft as Unknown when off-radar
    if (ac.status === 'Unknown') return 'unknown';
    if (ac.on_ground === true) return 'ground';
    // Has recent data = airborne (unless on_ground)
    const seen = ac.last_seen || ac.lastSeen || 0;
    if (seen && (Date.now() / 1000 - seen) < 600) return 'airborne';
    if (ac.lat != null && ac.lon != null) return 'airborne';
    return 'unknown';
  }

  function getLat(ac) { return ac.lat ?? ac.latitude ?? null; }
  function getLon(ac) { return ac.lon ?? ac.longitude ?? null; }
  function getHeading(ac) { return ac.heading ?? ac.track ?? 0; }
  function getReg(ac) { return ac.registration || ac.icao24 || '—'; }
  function getCallsign(ac) { return (ac.callsign || '').trim(); }
  function markerTooltip(ac) {
    const reg = getReg(ac);
    const cs = getCallsign(ac);
    const op = ac.operator || ac.ownOp || '';
    const parts = [`<b>${reg}</b>`];
    if (op) parts.push(`<span style="color:#a5b4fc">${op}</span>`);
    if (cs) parts.push(`✈ ${cs}`);
    // Climb/descend arrow
    const vr = ac.vertical_rate || ac.baro_rate || 0;
    if (vr > 300) parts.push(`<span style="color:#4ade80;font-size:14px">↑</span>`);
    else if (vr < -300) parts.push(`<span style="color:#fbbf24;font-size:14px">↓</span>`);
    let tip = parts.join(' <span style="opacity:0.3">·</span> ');
    // Route line
    const orig = ac.origin && ac.origin !== 'N/A' ? ac.origin : '';
    const dest = ac.destination && ac.destination !== 'N/A' ? ac.destination : '';
    if (orig || dest) {
      tip += `<br><span style="color:#93c5fd;font-size:11px;letter-spacing:0.5px">${orig || '?'} → ${dest || '?'}</span>`;
    }
    return tip;
  }
  function getLastSeen(ac) { return ac.last_seen || ac.lastSeen || 0; }

  const SQUAWK_EMERGENCY = {
    '7500': { label: 'HIJACK', color: '#ef4444' },
    '7600': { label: 'RADIO FAIL', color: '#f59e0b' },
    '7700': { label: 'EMERGENCY', color: '#ef4444' },
  };

  function getSquawkAlert(ac) {
    const sq = String(ac.squawk || '').trim();
    return SQUAWK_EMERGENCY[sq] || null;
  }

  function statusColor(status) {
    if (status === 'airborne') return '#22c55e';
    if (status === 'ground')   return '#6b7280';
    return '#f59e0b';
  }

  // ============================================================
  //  SVG AIRCRAFT ICON
  // ============================================================

  function aircraftSvg(color, heading) {
    return `
      <div class="aircraft-marker" style="transform: rotate(${heading || 0}deg);">
        <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
          <g transform="translate(16,16)">
            <path d="M0-14 L3-5 L12 2 L12 4 L3 1 L2 10 L5 12 L5 14 L0 12 L-5 14 L-5 12 L-2 10 L-3 1 L-12 4 L-12 2 L-3-5 Z"
                  fill="${color}" stroke="rgba(0,0,0,.4)" stroke-width=".7" />
          </g>
        </svg>
      </div>`;
  }

  // ============================================================
  //  MAP INIT
  // ============================================================

  const TILE_LAYERS = {
    dark: {
      url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
      attr: '&copy; <a href="https://carto.com/">CARTO</a> &copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
      subdomains: 'abcd',
    },
    voyager: {
      url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
      attr: '&copy; <a href="https://carto.com/">CARTO</a> &copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
      subdomains: 'abcd',
    },
    satellite: {
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      attr: '&copy; Esri',
    },
    osm: {
      url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      attr: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
    },
  };

  let currentTileLayer = null;
  let geofenceCircle = null;

  function updateGeofenceCircle(lat, lon, radiusNm) {
    const radiusMeters = radiusNm * 1852;
    if (geofenceCircle) {
      geofenceCircle.setLatLng([lat, lon]);
      geofenceCircle.setRadius(radiusMeters);
    } else if (map) {
      geofenceCircle = L.circle([lat, lon], {
        radius: radiusMeters,
        className: 'geofence-circle',
        interactive: false,
      }).addTo(map);
    }
  }

  function removeGeofenceCircle() {
    if (geofenceCircle) {
      map.removeLayer(geofenceCircle);
      geofenceCircle = null;
    }
  }

  function initMap() {
    map = L.map('map', {
      center: [32.0, 34.9],
      zoom: 7,
      zoomControl: false,
      attributionControl: true,
    });
    L.control.zoom({ position: 'bottomright' }).addTo(map);

    setMapStyle(localStorage.getItem('mapStyle') || 'dark');

    // Waypoint layers (separate per type)
    const wpKeys = { FIX: 'showFixes', VOR: 'showVOR', NDB: 'showNDB', DME: 'showDME' };
    Object.entries(wpKeys).forEach(([cat, key]) => {
      if (localStorage.getItem(key) === 'true') wpLayers[cat].addTo(map);
    });
    loadWaypoints();
    map.on('moveend zoomend', renderWaypointsInView);

    // FIR boundaries layer
    firLayer = L.layerGroup();
    if (localStorage.getItem('showFIR') === 'true') {
      firLayer.addTo(map);
    }
    loadFIRBoundaries();

    // North Atlantic Tracks (NAT) layer
    natLayer = L.layerGroup();
    if (localStorage.getItem('showNAT') === 'true') {
      natLayer.addTo(map);
    }
    loadNATTracks();
  }

  // ---- NAT Tracks ----
  let natLayer = null;

  async function loadNATTracks() {
    // Try live NAT tracks from FlightPlanDatabase API first
    let liveTracks = [];
    try {
      const res = await fetch('https://api.flightplandatabase.com/nav/NATS', {
        headers: { 'Accept': 'application/json' }
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) liveTracks = data;
      }
    } catch (e) { /* fallback to static */ }

    natLayer.clearLayers();

    if (liveTracks.length > 0) {
      // Draw live tracks from API
      const colors = ['#f59e0b', '#3b82f6', '#22c55e', '#ef4444', '#a855f7', '#06b6d4', '#ec4899', '#84cc16', '#f97316'];
      liveTracks.forEach((track, idx) => {
        if (!track.route || !track.route.nodes) return;
        const coords = track.route.nodes
          .filter(n => n.lat != null && n.lon != null)
          .map(n => [n.lat, n.lon]);
        if (coords.length < 2) return;
        const color = colors[idx % colors.length];
        const dir = track.direction === 'east' ? '→E' : '←W';
        L.polyline(coords, { color, weight: 2, opacity: 0.6, dashArray: '8 6' })
          .addTo(natLayer)
          .bindTooltip(`NAT ${track.ident} ${dir}`, { permanent: false, direction: 'center' });
      });
      return;
    }

    // Static fallback: typical NAT tracks using real oceanic coordinate waypoints
    // Format: [lat°N, lon°W] — these are the standard whole-degree oceanic fixes
    // Based on typical westbound track message structure
    const tracks = [
      { id: 'A', pts: [[57,-10],[58,-15],[59,-20],[59,-30],[58,-40],[56,-50]] },
      { id: 'B', pts: [[56,-10],[57,-15],[58,-20],[58,-30],[57,-40],[55,-50]] },
      { id: 'C', pts: [[55,-10],[56,-15],[57,-20],[57,-30],[56,-40],[54,-50]] },
      { id: 'D', pts: [[54,-10],[55,-15],[56,-20],[56,-30],[55,-40],[53,-50]] },
      { id: 'E', pts: [[53,-10],[54,-15],[55,-20],[55,-30],[54,-40],[52,-50]] },
      { id: 'F', pts: [[52,-10],[53,-15],[54,-20],[53,-30],[52,-40],[50,-50]] },
    ];
    const colors = ['#f59e0b','#3b82f6','#22c55e','#ef4444','#a855f7','#06b6d4'];

    tracks.forEach((t, idx) => {
      const color = colors[idx % colors.length];
      L.polyline(t.pts, {
        color, weight: 2, opacity: 0.5, dashArray: '8 6',
      }).addTo(natLayer);

      // Label at mid-ocean point
      const mid = t.pts[Math.floor(t.pts.length / 2)];
      L.marker(mid, {
        icon: L.divIcon({
          className: 'nat-track-label',
          html: `<span style="color:${color};font-size:11px;font-weight:700;text-shadow:0 0 6px #000,0 0 3px #000">${t.id}</span>`,
          iconSize: [16, 14], iconAnchor: [8, 7],
        }),
        interactive: false,
      }).addTo(natLayer);
    });

    // Shanwick OCA boundary (~15°W) and Gander OCA boundary (~53°W)
    L.polyline([[49,-15],[59,-15]], { color: '#94a3b8', weight: 1, opacity: 0.25, dashArray: '4 8' })
      .addTo(natLayer).bindTooltip('Shanwick', { permanent: false, direction: 'right' });
    L.polyline([[48,-53],[58,-53]], { color: '#94a3b8', weight: 1, opacity: 0.25, dashArray: '4 8' })
      .addTo(natLayer).bindTooltip('Gander', { permanent: false, direction: 'left' });
  }


  // ---- Waypoints Layers (separate per type) ----
  let waypointsData = [];
  const wpLayers = {
    FIX: L.layerGroup(),
    VOR: L.layerGroup(),
    NDB: L.layerGroup(),
    DME: L.layerGroup(),
  };
  let renderedWpBounds = null;

  function wpCategory(t) {
    if (!t) return 'FIX';
    if (t === 'FIX' || t === 'RNAV' || t === 'WPT' || t === 'INT' || t === 'WYP' || t === 'VHF') return 'FIX';
    if (t.startsWith('VOR')) return 'VOR';
    if (t.startsWith('NDB')) return 'NDB';
    if (t === 'DME' || t === 'TACAN') return 'DME';
    return 'FIX';
  }

  async function loadWaypoints() {
    try {
      const res = await fetch('/waypoints.json');
      if (res.ok) {
        waypointsData = await res.json();
        console.log(`✈️ Loaded ${waypointsData.length} waypoints`);
        renderWaypointsInView();
      }
    } catch (e) { console.warn('Could not load waypoints:', e); }
  }

  function waypointSvg(type) {
    const colors = {
      'VOR': '#22d3ee', 'VOR-DME': '#22d3ee', 'VORTAC': '#22d3ee',
      'NDB': '#a78bfa', 'NDB-DME': '#a78bfa',
      'DME': '#fb923c', 'TACAN': '#fb923c',
      'FIX': '#4ade80', 'RNAV': '#4ade80',
    };
    const c = colors[type] || '#9ca3af';
    if (type === 'FIX' || type === 'RNAV' || type === 'WPT' || type === 'INT' || type === 'WYP' || type === 'VHF') {
      return `<svg width="10" height="10" viewBox="0 0 10 10"><polygon points="5,1 9,9 1,9" fill="none" stroke="${c}" stroke-width="1.2"/></svg>`;
    } else if (type.startsWith('VOR')) {
      return `<svg width="12" height="12" viewBox="0 0 14 14"><polygon points="7,1 12.5,4 12.5,10 7,13 1.5,10 1.5,4" fill="none" stroke="${c}" stroke-width="1.5"/><circle cx="7" cy="7" r="1.5" fill="${c}"/></svg>`;
    } else if (type.startsWith('NDB')) {
      return `<svg width="12" height="12" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5" fill="none" stroke="${c}" stroke-width="1.5" stroke-dasharray="2,2"/><circle cx="7" cy="7" r="1.5" fill="${c}"/></svg>`;
    } else {
      return `<svg width="12" height="12" viewBox="0 0 14 14"><rect x="2" y="2" width="10" height="10" fill="none" stroke="${c}" stroke-width="1.5"/><circle cx="7" cy="7" r="1.5" fill="${c}"/></svg>`;
    }
  }

  function anyWpLayerActive() {
    return Object.values(wpLayers).some(l => map.hasLayer(l));
  }

  function renderWaypointsInView() {
    if (!map || waypointsData.length === 0) return;
    if (!anyWpLayerActive()) return;

    const zoom = map.getZoom();
    if (zoom < 6) {
      Object.values(wpLayers).forEach(l => l.clearLayers());
      renderedWpBounds = null;
      return;
    }

    const bounds = map.getBounds();
    if (renderedWpBounds) {
      const ob = renderedWpBounds;
      if (Math.abs(ob._southWest.lat - bounds._southWest.lat) < 0.3 &&
          Math.abs(ob._northEast.lat - bounds._northEast.lat) < 0.3) return;
    }
    renderedWpBounds = bounds;

    Object.values(wpLayers).forEach(l => l.clearLayers());
    const ne = bounds._northEast;
    const sw = bounds._southWest;
    const pad = 0.5;
    const counts = { FIX: 0, VOR: 0, NDB: 0, DME: 0 };
    // At low zoom show only navaids; at high zoom show fixes too
    const showFixes = zoom >= 8;
    const maxFixes = zoom < 10 ? 400 : 800;
    const maxNavaids = zoom < 8 ? 150 : 400;

    for (const wp of waypointsData) {
      if (wp.lat < sw.lat - pad || wp.lat > ne.lat + pad ||
          wp.lon < sw.lng - pad || wp.lon > ne.lng + pad) continue;

      const cat = wpCategory(wp.t);

      // Skip if that layer isn't on the map
      if (!map.hasLayer(wpLayers[cat])) continue;

      // Limit count per category
      if (cat === 'FIX') {
        if (!showFixes || counts.FIX >= maxFixes) continue;
      } else {
        if (counts[cat] >= maxNavaids) continue;
      }

      const freqStr = wp.freq ? (wp.t?.includes('NDB') ? `${wp.freq} kHz` : `${wp.freq} MHz`) : '';
      const nameStr = wp.name ? ` — ${wp.name}` : '';
      const marker = L.marker([wp.lat, wp.lon], {
        icon: L.divIcon({
          className: 'navaid-marker',
          html: `<div class="navaid-icon">${waypointSvg(wp.t)}<span class="navaid-label">${wp.id}</span></div>`,
          iconSize: [40, 16],
          iconAnchor: [5, 5],
        }),
        interactive: true,
      });

      marker.bindTooltip(
        `<b>${wp.id}</b>${nameStr}<br>${wp.t}${freqStr ? ' · ' + freqStr : ''}`,
        { className: 'navaid-tooltip', direction: 'top', offset: [0, -8] }
      );

      wpLayers[cat].addLayer(marker);
      counts[cat]++;
    }
  }

  function setMapStyle(name) {
    const cfg = TILE_LAYERS[name] || TILE_LAYERS.dark;
    if (currentTileLayer) map.removeLayer(currentTileLayer);
    currentTileLayer = L.tileLayer(cfg.url, {
      attribution: cfg.attr,
      subdomains: cfg.subdomains || 'abc',
      maxZoom: 19,
    }).addTo(map);
    localStorage.setItem('mapStyle', name);
  }

  // ============================================================
  //  MARKERS
  // ============================================================

  function createOrUpdateMarker(icao, ac) {
    const lat = getLat(ac);
    const lon = getLon(ac);
    if (lat == null || lon == null) return;

    const status  = getStatus(ac);
    const heading = getHeading(ac);
    const color   = statusColor(status);
    const entry   = aircraftData[icao];

    if (entry.marker) {
      // Smooth marker glide using CSS transition
      const el = entry.marker.getElement();
      if (el) el.style.transition = 'transform 1s linear';
      entry.marker.setLatLng([lat, lon]);
      entry.marker.setIcon(L.divIcon({
        className: '',
        html: aircraftSvg(color, heading),
        iconSize: [32, 32],
        iconAnchor: [16, 16],
      }));
      entry.marker.setTooltipContent(markerTooltip(ac));
    } else {
      const icon = L.divIcon({
        className: '',
        html: aircraftSvg(color, heading),
        iconSize: [32, 32],
        iconAnchor: [16, 16],
      });

      const marker = L.marker([lat, lon], { icon })
        .addTo(map)
        .bindTooltip(markerTooltip(ac), { direction: 'top', offset: [0, -18] });

      marker.on('click', (e) => {
        if (activeIcao === icao && entry.marker?.isPopupOpen?.()) {
          // Already active — close popup and collapse card
          entry.marker.closePopup();
          activeIcao = null;
          const card = document.querySelector(`.aircraft-card[data-icao="${icao}"]`);
          if (card) card.classList.remove('expanded', 'active');
        } else {
          // Open popup and expand card
          activeIcao = icao;
          map.panTo([lat, lon], { animate: true });
          openPopup(icao);
          // Sync card
          document.querySelectorAll('.aircraft-card').forEach(c => {
            const isThis = c.dataset.icao === icao;
            c.classList.toggle('active', isThis);
            c.classList.toggle('expanded', isThis);
          });
          // Scroll card into view
          const card = document.querySelector(`.aircraft-card[data-icao="${icao}"]`);
          if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
        renderSidebar();
      });

      entry.marker = marker;
    }

    // --- trail ---
    if (!entry.trail) entry.trail = [];
    const last = entry.trail[entry.trail.length - 1];
    if (!last || Math.abs(last[0] - lat) > 0.0001 || Math.abs(last[1] - lon) > 0.0001) {
      entry.trail.push([lat, lon]);
      if (entry.trail.length > TRAIL_MAX) entry.trail.shift();
    }

    // Single clean trail line — update in place, don't recreate
    if (entry.trail.length > 1 && trailVisible.has(icao)) {
      if (entry.trailLine) {
        entry.trailLine.setLatLngs(entry.trail);
      } else {
        entry.trailLine = L.polyline(entry.trail, {
          color: color,
          weight: 2.5,
          opacity: 0.7,
          lineCap: 'round',
          lineJoin: 'round',
          className: 'trail-segment',
        }).addTo(map);
      }
    } else if (entry.trailLine && !trailVisible.has(icao)) {
      map.removeLayer(entry.trailLine);
      entry.trailLine = null;
    }
    // Clean up old gradient segments if they exist
    if (entry.trailSegments && entry.trailSegments.length > 0) {
      entry.trailSegments.forEach(seg => map.removeLayer(seg));
      entry.trailSegments = [];
    }

    // --- flight path to destination ---
    if (ac.dest_lat && ac.dest_lon && lat && lon) {
      const pathCoords = [[lat, lon], [ac.dest_lat, ac.dest_lon]];
      if (entry.pathLine) {
        entry.pathLine.setLatLngs(pathCoords);
      } else {
        entry.pathLine = L.polyline(pathCoords, {
          color: '#60a5fa',
          weight: 1.5,
          opacity: 0.35,
          dashArray: '8 8',
          className: 'flight-path',
        }).addTo(map);
      }
    } else if (entry.pathLine) {
      map.removeLayer(entry.pathLine);
      entry.pathLine = null;
    }
  }

  function fitBounds() {
    const bounds = [];
    Object.values(aircraftData).forEach(ad => {
      if (ad.marker) bounds.push(ad.marker.getLatLng());
    });
    if (bounds.length > 0) {
      map.fitBounds(L.latLngBounds(bounds).pad(0.15), { maxZoom: 10 });
    }
  }

  // ============================================================
  //  AIRPORT MARKERS
  // ============================================================

  function airportIcon(isFav, type) {
    // Gold = favorite, Green = origin/departure, Blue = destination/arrival
    const color = isFav ? '#f59e0b' : type === 'origin' ? '#22c55e' : '#3b82f6';
    const bg = isFav ? 'rgba(245,158,11,.15)' : type === 'origin' ? 'rgba(34,197,94,.15)' : 'rgba(59,130,246,.15)';
    return L.divIcon({
      className: '',
      html: `<div class="airport-pin" style="--pin-color:${color};--pin-bg:${bg}">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2">
          <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/>
          <circle cx="12" cy="9" r="2.5" fill="${color}"/>
        </svg>
      </div>`,
      iconSize: [24, 24],
      iconAnchor: [12, 24],
    });
  }

  function renderFavChips() {
    const $list = document.getElementById('fav-airport-list');
    if (!$list) return;
    $list.innerHTML = favoriteAirports.map(code =>
      `<span class="fav-chip">${code}<span class="fav-chip-x" data-code="${code}">×</span></span>`
    ).join('');
    $list.querySelectorAll('.fav-chip-x').forEach(el => {
      el.addEventListener('click', async () => {
        const code = el.dataset.code;
        try {
          await fetch(`${API_BASE}/api/favorites`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ remove: code }),
          });
        } catch (e) {}
      });
    });
  }

  function updateAirportMarkers() {
    // Collect airports from current aircraft data (route-related only)
    const airports = {};

    Object.values(aircraftData).forEach(ad => {
      const ac = ad.data;
      if (ac.origin && ac.origin !== 'N/A' && ac.origin_lat && ac.origin_lon) {
        const key = ac.origin;
        if (!airports[key]) airports[key] = { lat: ac.origin_lat, lon: ac.origin_lon, type: 'origin', names: [], favorite: false };
        airports[key].names.push(ac.origin_city || ac.origin);
      }
      if (ac.destination && ac.destination !== 'N/A' && ac.dest_lat && ac.dest_lon) {
        const key = ac.destination;
        if (!airports[key]) airports[key] = { lat: ac.dest_lat, lon: ac.dest_lon, type: 'dest', names: [], favorite: false };
        airports[key].names.push(ac.dest_city || ac.destination);
      }
    });

    // Always add favorite airports (even without active traffic)
    for (const code of favoriteAirports) {
      const coords = favAirportCoords[code];
      if (coords && coords.lat) {
        if (!airports[code]) airports[code] = { lat: coords.lat, lon: coords.lon, type: 'favorite', names: [coords.city || code], favorite: true };
        airports[code].favorite = true;
      }
    }

    // Remove old markers that are no longer needed
    Object.keys(airportMarkers).forEach(code => {
      if (!airports[code]) {
        map.removeLayer(airportMarkers[code]);
        delete airportMarkers[code];
      }
    });

    // Add/update markers
    Object.entries(airports).forEach(([code, info]) => {
      const name = info.names[0] || code;
      const wx = weatherData[code];

      // Show last recorded runway, but fall back to prediction if >20min stale
      const history = runwayHistoryData[code] || [];
      let lastArr = null, lastDep = null;
      for (let i = history.length - 1; i >= 0; i--) {
        const h = history[i];
        if (!lastArr && h.type === 'ARR') lastArr = h;
        if (!lastDep && h.type === 'DEP') lastDep = h;
        if (lastArr && lastDep) break;
      }

      const STALE_MS = 20 * 60 * 1000; // 20 minutes
      const now = Date.now();

      // If ARR is stale (>20min), use best prediction from tracked aircraft
      let arrRwy = null, arrLabel = '';
      if (lastArr && (now - lastArr.ts) < STALE_MS) {
        arrRwy = lastArr.runway;
        arrLabel = getRelativeTime(Math.floor(lastArr.ts / 1000));
      } else {
        // Fallback: best predicted_runway from aircraft heading to this airport
        const confPriority = { HIGH: 5, TRAFFIC: 4, 'HIST+WIND': 3, WIND: 2, HIST: 1, LOW: 0 };
        let bestConf = -1;
        Object.values(aircraftData).forEach(ad => {
          const ac = ad.data;
          if (ac.predicted_runway && ac.destination === code) {
            const conf = confPriority[ac.runway_confidence] ?? 0;
            if (conf > bestConf) { bestConf = conf; arrRwy = ac.predicted_runway; }
          }
        });
        if (arrRwy) arrLabel = 'pred';
      }

      // If DEP is stale (>20min), use best prediction from aircraft departing this airport
      let depRwy = null, depLabel = '';
      if (lastDep && (now - lastDep.ts) < STALE_MS) {
        depRwy = lastDep.runway;
        depLabel = getRelativeTime(Math.floor(lastDep.ts / 1000));
      } else {
        const confPriority = { HIGH: 5, TRAFFIC: 4, 'HIST+WIND': 3, WIND: 2, HIST: 1, LOW: 0 };
        let bestConf = -1;
        Object.values(aircraftData).forEach(ad => {
          const ac = ad.data;
          if (ac.dep_runway && ac.origin === code) {
            const conf = confPriority[ac.dep_runway_confidence] ?? 0;
            if (conf > bestConf) { bestConf = conf; depRwy = ac.dep_runway; }
          }
        });
        if (depRwy) depLabel = 'pred';
      }

      let rwyBadges = '';
      const badges = [];
      if (arrRwy) {
        badges.push(`<span class="wx-rwy${arrLabel === 'pred' ? ' hist' : ''}"><span class="wx-rwy-use arr">ARR</span> ${arrRwy} <span class="wx-rwy-ago">${arrLabel}</span></span>`);
      }
      if (depRwy) {
        badges.push(`<span class="wx-rwy${depLabel === 'pred' ? ' hist' : ''}"><span class="wx-rwy-use dep">DEP</span> ${depRwy} <span class="wx-rwy-ago">${depLabel}</span></span>`);
      }
      rwyBadges = badges.join(' ');

      // Compact tooltip (hover)
      let tooltipHtml = `<b>${code}</b> ${name}`;

      // Horizontal popup (click to pin)
      let popupHtml = `<div class="wx-popup-h">
        <div class="wx-header">
          <span class="wx-code">${code}</span>
          <span class="wx-name">${name}</span>
        </div>
        <div class="wx-runways">${rwyBadges}</div>
        <div class="wx-divider"></div>
        <div class="wx-section-header">
          <span class="wx-section-title">Weather</span>
          <button class="wx-refresh-btn" onclick="window._refreshWeather('${code}')" title="Refresh METAR/TAF">🔄</button>
        </div>`;

      if (wx?.metar || wx?.taf) {
        if (wx?.parsed) {
          const p = wx.parsed;
          const windStr = p.wdir != null ? `${String(p.wdir).padStart(3,'0')}°/${p.wspd}kt${p.wgst ? 'G'+p.wgst : ''}` : '';
          const tempStr = p.temp != null ? `${p.temp}°/${p.dewp ?? '?'}°C` : '';
          const visStr = p.visib != null ? `Vis ${p.visib === '6+' ? '>6SM' : p.visib + 'SM'}` : '';
          const qnhStr = p.altim ? `Q${p.altim}` : '';
          const catClass = (p.fltCat || '').toLowerCase();
          const catBadge = p.fltCat ? `<span class="wx-cat wx-cat-${catClass}">${p.fltCat}</span>` : '';
          const ceilStr = p.ceiling ? `Ceil ${p.ceiling}ft` : '';
          const parts = [windStr, tempStr, visStr, ceilStr, qnhStr].filter(Boolean).join(' · ');
          let ageStr = '';
          if (p.obsTime) {
            const mins = Math.round((Date.now() - p.obsTime) / 60000);
            ageStr = mins < 1 ? 'just now' : mins < 60 ? `${mins}min ago` : `${Math.floor(mins/60)}h${mins%60}m ago`;
          }
          popupHtml += `<div class="wx-summary">${catBadge}<span class="wx-summary-data">${parts}</span>${ageStr ? `<span class="wx-age">${ageStr}</span>` : ''}</div>`;
        }
        popupHtml += `<div class="wx-grid">`;
        if (wx?.metar) {
          popupHtml += `<div class="wx-block"><div class="wx-block-label">METAR</div><code>${wx.metar}</code></div>`;
        }
        if (wx?.taf) {
          popupHtml += `<div class="wx-block"><div class="wx-block-label">TAF</div><code>${wx.taf.replace(/\n/g, '<br>')}</code></div>`;
        }
        popupHtml += `</div>`;
      } else {
        popupHtml += `<div class="wx-none">No weather data</div>`;
      }
      popupHtml += `</div>`;

      if (!airportMarkers[code]) {
        const marker = L.marker([info.lat, info.lon], {
          icon: airportIcon(info.favorite, info.type),
          zIndexOffset: -100,
          interactive: true,
        }).addTo(map);

        marker.bindTooltip(tooltipHtml, {
          direction: 'top',
          offset: [0, -20],
          className: 'airport-tooltip',
        });

        // Leaflet handles click-to-open natively with bindPopup
        marker.bindPopup(popupHtml, {
          className: 'dark-popup wx-popup-container',
          maxWidth: 700,
          minWidth: 450,
          closeOnClick: false,
          autoClose: false,
        });

        airportMarkers[code] = marker;
      } else {
        // Update tooltip, popup, and icon with latest data
        airportMarkers[code].setTooltipContent(tooltipHtml);
        airportMarkers[code].setPopupContent(popupHtml);
        airportMarkers[code].setIcon(airportIcon(info.favorite, info.type));
      }
    });
  }

  function openPopup(icao) {
    const entry = aircraftData[icao];
    if (!entry || !entry.marker) return;
    const ac = entry.data;
    const status = getStatus(ac);

    const alt = ac.altitude;
    const spd = ac.velocity;
    const vr  = ac.vertical_rate;
    const heading = getHeading(ac);
    const vrLabel = vr > 100 ? '▲ Climbing' : vr < -100 ? '▼ Descending' : '◆ Level';

    // Route line
    let routeLine = '';
    if (ac.origin && ac.destination && ac.origin !== 'N/A') {
      routeLine = `<div class="popup-route">${ac.origin} → ${ac.destination}</div>`;
    }

    // Time formatting helper
    function fmtTime(isoStr, tz) {
      if (!isoStr) return null;
      try {
        const d = new Date(isoStr);
        if (isNaN(d)) return null;
        const utc = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
        let local = utc; // fallback
        if (tz) {
          try { local = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz }); } catch(e) {}
        }
        return tz && local !== utc ? `${local} local / ${utc}z` : `${utc}z`;
      } catch(e) { return null; }
    }

    // ETD / ETA
    const etdStr = fmtTime(ac.etd, ac.origin_tz);
    const etaStr = fmtTime(ac.eta, ac.dest_tz);

    // Calculated ETA countdown
    let etaLine = '';
    if (ac.calc_eta) {
      const eta = new Date(ac.calc_eta);
      const minLeft = Math.max(0, Math.round((eta - Date.now()) / 60000));
      const h = Math.floor(minLeft / 60);
      const m = minLeft % 60;
      const timeStr = eta.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      etaLine = `~${h ? h+'h':''}${m}m (${timeStr})`;
    }

    const html = `
      <div class="popup-inner">
        <div class="popup-header">
          <span class="status-dot ${status}"></span>
          <span class="popup-reg">${getReg(ac)}</span>
          <span class="popup-callsign">${getCallsign(ac)}</span>
        </div>
        ${routeLine}
        <div class="popup-grid">
          <div class="popup-field">
            <span class="popup-field-label">Altitude</span>
            <span class="popup-field-value">${formatAltitude(alt)}</span>
          </div>
          <div class="popup-field">
            <span class="popup-field-label">Speed</span>
            <span class="popup-field-value">${formatSpeed(spd)}</span>
          </div>
          <div class="popup-field">
            <span class="popup-field-label">Heading</span>
            <span class="popup-field-value">${heading}°</span>
          </div>
          <div class="popup-field">
            <span class="popup-field-label">Vert Rate</span>
            <span class="popup-field-value">${vr != null ? vrLabel + ' ' + vr + ' ft/m' : '—'}</span>
          </div>
          ${ac.squawk ? `
          <div class="popup-field">
            <span class="popup-field-label">Squawk</span>
            <span class="popup-field-value">${ac.squawk}</span>
          </div>` : ''}
          ${ac.model || ac.t || ac.type ? `
          <div class="popup-field">
            <span class="popup-field-label">Type</span>
            <span class="popup-field-value">${ac.model || ac.t || ac.type}</span>
          </div>` : ''}
          ${ac.operator || ac.ownOp ? `
          <div class="popup-field">
            <span class="popup-field-label">Operator</span>
            <span class="popup-field-value">${ac.operator || ac.ownOp}</span>
          </div>` : ''}
          ${ac.dep_runway ? `
          <div class="popup-field">
            <span class="popup-field-label">DEP ${ac.origin || ''}</span>
            <span class="popup-field-value">RWY ${ac.dep_runway} <span class="rwy-conf ${(ac.dep_runway_confidence||'').toLowerCase()}">${ac.dep_runway_confidence || ''}</span></span>
          </div>` : ''}
          ${ac.dep_runway_wind && ac.dep_runway ? `
          <div class="popup-field">
            <span class="popup-field-label">DEP Wind</span>
            <span class="popup-field-value">${ac.dep_runway_wind}${ac.dep_runway_headwind != null ? ' (HW ' + ac.dep_runway_headwind + 'kt)' : ''}</span>
          </div>` : ''}
          ${ac.predicted_runway ? `
          <div class="popup-field">
            <span class="popup-field-label">ARR ${ac.destination || ''}</span>
            <span class="popup-field-value">RWY ${ac.predicted_runway} <span class="rwy-conf ${(ac.runway_confidence||'').toLowerCase()}">${ac.runway_confidence || ''}</span></span>
          </div>` : ''}
          ${ac.runway_wind && ac.predicted_runway ? `
          <div class="popup-field">
            <span class="popup-field-label">ARR Wind</span>
            <span class="popup-field-value">${ac.runway_wind}${ac.runway_headwind != null ? ' (HW ' + ac.runway_headwind + 'kt)' : ''}</span>
          </div>` : ''}
          ${etdStr ? `
          <div class="popup-field">
            <span class="popup-field-label">Departed</span>
            <span class="popup-field-value">${etdStr}</span>
          </div>` : ''}
          ${etaStr ? `
          <div class="popup-field">
            <span class="popup-field-label">Sched. Arrival</span>
            <span class="popup-field-value">${etaStr}</span>
          </div>` : ''}
          ${etaLine ? `
          <div class="popup-field">
            <span class="popup-field-label">ETA (calc)</span>
            <span class="popup-field-value">${etaLine}</span>
          </div>` : ''}
          ${ac.remaining_nm ? `
          <div class="popup-field">
            <span class="popup-field-label">Remaining</span>
            <span class="popup-field-value">${ac.remaining_nm} nm</span>
          </div>` : ''}
          ${ac.signal_source ? `
          <div class="popup-field">
            <span class="popup-field-label">Source</span>
            <span class="popup-field-value">${ac.signal_source}</span>
          </div>` : ''}
        </div>
      </div>`;

    entry.marker.bindPopup(html, { maxWidth: 320, autoPan: true }).openPopup();
  }

  function removeMarker(icao) {
    const entry = aircraftData[icao];
    if (!entry) return;
    if (entry.marker) { map.removeLayer(entry.marker); }
    if (entry.trailSegments) { entry.trailSegments.forEach(seg => map.removeLayer(seg)); }
    if (entry.trailLine) { map.removeLayer(entry.trailLine); }
    if (entry.pathLine) { map.removeLayer(entry.pathLine); }
    delete aircraftData[icao];
  }

  // ============================================================
  //  SIDEBAR RENDERING
  // ============================================================

  function renderSidebar() {
    const entries = Object.entries(aircraftData);
    $empty.style.display = entries.length ? 'none' : 'flex';

    // stats
    let airborne = 0, ground = 0;
    entries.forEach(([, e]) => {
      const s = getStatus(e.data);
      if (s === 'airborne') airborne++;
      else if (s === 'ground') ground++;
    });
    $statTotal.textContent    = entries.length;
    $statAirborne.textContent = airborne;
    $statGround.textContent   = ground;

    // sort based on selected mode
    const sortMode = document.getElementById('sort-select')?.value || 'status';
    const statusOrder = { airborne: 0, ground: 1, unknown: 2 };

    if (sortMode === 'status') {
      entries.sort((a, b) => (statusOrder[getStatus(a[1].data)] ?? 3) - (statusOrder[getStatus(b[1].data)] ?? 3));
    } else if (sortMode === 'reg') {
      entries.sort((a, b) => {
        const rA = (a[1].data?.registration || a[0]).toUpperCase();
        const rB = (b[1].data?.registration || b[0]).toUpperCase();
        return rA.localeCompare(rB);
      });
    } else if (sortMode === 'recent') {
      entries.sort((a, b) => (b[1].data?.last_seen || 0) - (a[1].data?.last_seen || 0));
    }

    // Pinned items always on top
    entries.sort((a, b) => (b[1].pinned ? 1 : 0) - (a[1].pinned ? 1 : 0));

    // reconcile DOM — keep expanded state
    // reconcile DOM — update cards in place, preserve expanded
    const existingCards = $list.querySelectorAll('.aircraft-card');
    const existingMap = {};
    existingCards.forEach(c => { existingMap[c.dataset.icao] = c; });

    const newCards = [];
    const seenIcaos = new Set();

    entries.forEach(([icao, entry]) => {
      seenIcaos.add(icao);
      const ac = entry.data;
      const status = getStatus(ac);

      let card = existingMap[icao];
      if (card) {
        updateCardContent(card, icao, ac, status);
      } else {
        card = buildCard(icao, ac, status);
        card.classList.add('card-new');
        card.addEventListener('animationend', () => card.classList.remove('card-new'), { once: true });
      }
      newCards.push(card);
    });

    // Remove stale cards
    existingCards.forEach(c => {
      if (!seenIcaos.has(c.dataset.icao)) c.remove();
    });

    // Remove empty state if present
    const emptyEl = $list.querySelector('.empty-state, [style*="opacity"]');
    if (emptyEl && entries.length > 0) emptyEl.remove();

    // Reorder: only move cards whose position actually changed
    if (entries.length === 0) {
      $list.innerHTML = '';
      $list.appendChild($empty);
    } else {
      const currentChildren = [...$list.children].filter(c => c.classList.contains('aircraft-card'));
      let needsReorder = currentChildren.length !== newCards.length;
      if (!needsReorder) {
        for (let i = 0; i < newCards.length; i++) {
          if (currentChildren[i] !== newCards[i]) { needsReorder = true; break; }
        }
      }
      if (needsReorder) {
        newCards.forEach(card => $list.appendChild(card));
      }
    }
  }

  function cardTooltip(ac) {
    const parts = [];
    const operator = ac.operator || ac.ownOp;
    const callsign = (ac.callsign || '').trim();
    const model = ac.model || ac.t || ac.type;
    if (operator) parts.push(operator);
    if (callsign) parts.push(`Flight ${callsign}`);
    if (model) parts.push(model);
    return parts.join(' · ') || '';
  }

  function buildCard(icao, ac, status) {
    const card = document.createElement('div');
    card.className = `aircraft-card${icao === activeIcao ? ' active' : ''}`;
    card.dataset.icao = icao;
    card.title = cardTooltip(ac);
    card.innerHTML = cardHTML(icao, ac, status);
    attachCardEvents(card, icao);
    return card;
  }

  function updateCardContent(card, icao, ac, status) {
    const isExpanded = card.classList.contains('expanded');
    const newClass = `aircraft-card${icao === activeIcao ? ' active' : ''}${isExpanded ? ' expanded' : ''}`;
    if (card.className !== newClass) card.className = newClass;
    card.title = cardTooltip(ac);
    const newHTML = cardHTML(icao, ac, status);
    if (card.innerHTML !== newHTML) {
      card.innerHTML = newHTML;
      attachCardEvents(card, icao);
    }
  }

  function cardHTML(icao, ac, status) {
    const reg  = getReg(ac);
    const cs   = getCallsign(ac);
    const alt  = ac.altitude;
    const spd  = ac.velocity;
    const vr   = ac.vertical_rate;
    const pinned = aircraftData[icao]?.pinned;

    // Route — server uses origin/destination
    let routeHtml = '';
    const origin = ac.origin;
    const dest = ac.destination;
    if (origin && dest && origin !== 'N/A') {
      const oc = ac.origin_city ? ` (${ac.origin_city})` : '';
      const dc = ac.dest_city ? ` (${ac.dest_city})` : '';
      routeHtml = `<div class="card-route">${origin}${oc} <span class="arrow">→</span> ${dest}${dc}</div>`;
    }

    // Info tags
    let infoHtml = '';
    if (status === 'airborne') {
      const altArrow = vr > 100 ? '▲' : vr < -100 ? '▼' : '◆';
      const altClass = vr > 100 ? 'climbing' : vr < -100 ? 'descending' : '';
      infoHtml = `
        <span class="card-tag altitude ${altClass}">${altArrow} ${formatAltitude(alt)}</span>
        <span class="card-tag speed">◈ ${formatSpeed(spd)}</span>`;
      // Use calculated ETA if available, otherwise fall back to schedule
      if (ac.calc_eta) {
        const eta = new Date(ac.calc_eta);
        const minLeft = Math.max(0, Math.round((eta - Date.now()) / 60000));
        const h = Math.floor(minLeft / 60);
        const m = minLeft % 60;
        const timeStr = eta.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        infoHtml += `<span class="card-tag eta">⏱ ~${h ? h+'h':''}${m}m (${timeStr})</span>`;
        if (ac.remaining_nm) infoHtml += `<span class="card-tag dist">${ac.remaining_nm}nm</span>`;
      } else if (ac.eta) {
        infoHtml += `<span class="card-tag eta">⏱ ${formatETA(ac.eta)}</span>`;
      }
    } else if (status === 'ground') {
      infoHtml = `<span class="card-tag ground-tag">On Ground</span>`;
    } else {
      const lastTime = getLastSeen(ac);
      infoHtml = `<span class="card-tag unknown-tag">No Signal${lastTime ? ' · ' + getRelativeTime(lastTime) : ''}</span>`;
    }

    // Squawk emergency alert
    const sqAlert = getSquawkAlert(ac);
    const sqHtml = sqAlert
      ? `<div class="squawk-alert" style="--sq-color:${sqAlert.color}">🚨 SQUAWK ${ac.squawk} — ${sqAlert.label}</div>`
      : '';

    // Expanded details
    const heading = getHeading(ac);
    const detailsHtml = `
      <div class="card-details">
        <div class="details-grid">
          <div class="detail-item"><span class="detail-label">ICAO</span><span class="detail-value">${icao}</span></div>
          <div class="detail-item"><span class="detail-label">Heading</span><span class="detail-value">${heading}°</span></div>
          <div class="detail-item"><span class="detail-label">Vert Rate</span><span class="detail-value">${vr != null ? vr + ' ft/m' : '—'}</span></div>
          <div class="detail-item"><span class="detail-label">Squawk</span><span class="detail-value${sqAlert ? ' squawk-emergency' : ''}">${ac.squawk || '—'}</span></div>
          <div class="detail-item"><span class="detail-label">Type</span><span class="detail-value">${ac.model || ac.t || ac.type || '—'}</span></div>
          <div class="detail-item"><span class="detail-label">Operator</span><span class="detail-value">${ac.operator || ac.ownOp || '—'}</span></div>
          ${ac.dep_runway ? `<div class="detail-item"><span class="detail-label">DEP ${ac.origin || ''}</span><span class="detail-value rwy-value">RWY ${ac.dep_runway} <span class="rwy-conf ${(ac.dep_runway_confidence||'').toLowerCase()}">${ac.dep_runway_confidence || ''}</span></span></div>` : ''}
          ${ac.dep_runway_wind && ac.dep_runway ? `<div class="detail-item"><span class="detail-label">DEP Wind</span><span class="detail-value">${ac.dep_runway_wind}${ac.dep_runway_headwind != null ? ` (HW ${ac.dep_runway_headwind}kt)` : ''}</span></div>` : ''}
          ${ac.predicted_runway ? `<div class="detail-item"><span class="detail-label">ARR ${ac.destination || ''}</span><span class="detail-value rwy-value">RWY ${ac.predicted_runway} <span class="rwy-conf ${(ac.runway_confidence||'').toLowerCase()}">${ac.runway_confidence || ''}</span></span></div>` : ''}
          ${ac.runway_wind && ac.predicted_runway ? `<div class="detail-item"><span class="detail-label">ARR Wind</span><span class="detail-value">${ac.runway_wind}${ac.runway_headwind != null ? ` (HW ${ac.runway_headwind}kt)` : ''}</span></div>` : ''}
          ${ac.signal_source ? `<div class="detail-item"><span class="detail-label">Source</span><span class="detail-value src-badge">${ac.signal_source}</span></div>` : ''}
          ${ac.avg_speed ? `<div class="detail-item"><span class="detail-label">Avg GS</span><span class="detail-value">${ac.avg_speed} kts</span></div>` : ''}
        </div>
      </div>`;

    return `
      <div class="card-actions">
        <button class="card-action-btn pin-btn${pinned ? ' pinned' : ''}" title="Pin">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="${pinned ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M12 2l3 7h7l-5.5 4.5L18 21l-6-4-6 4 1.5-7.5L2 9h7z"/></svg>
        </button>
        <button class="card-action-btn remove-btn remove" title="Remove">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      ${sqHtml}
      <div class="card-row-top">
        <span class="status-dot ${status}"></span>
        <span class="card-reg">${reg}</span>
        ${cs ? `<span class="card-callsign">${cs}</span>` : ''}
        <span class="status-badge ${status}">${status}</span>
      </div>
      ${routeHtml}
      ${ac.progress != null && status === 'airborne' ? `<div class="progress-bar-wrap"><div class="progress-bar" style="width:${ac.progress}%"></div><span class="progress-label">${ac.progress}%</span></div>` : ''}
      <div class="card-info-row">${infoHtml}</div>
      ${detailsHtml}`;
  }

  function attachCardEvents(card, icao) {
    // click body → center & expand
    card.addEventListener('click', (e) => {
      // Skip clicks on action buttons
      if (e.target.closest('.card-action-btn')) return;
      // Skip clicks on interactive detail elements
      if (e.target.closest('.progress-bar-wrap')) return;

      e.stopPropagation();
      const entry = aircraftData[icao];
      if (!entry) return;

      const wasExpanded = card.classList.contains('expanded');

      if (wasExpanded) {
        // Collapse card and close popup
        card.classList.remove('expanded', 'active');
        if (entry.marker) entry.marker.closePopup();
        activeIcao = null;
      } else {
        // Expand this card, collapse others
        document.querySelectorAll('.aircraft-card').forEach(c => {
          c.classList.remove('expanded', 'active');
        });
        card.classList.add('expanded', 'active');
        activeIcao = icao;

        const lat = getLat(entry.data);
        const lon = getLon(entry.data);
        if (lat != null && lon != null) {
          map.panTo([lat, lon], { animate: true });
          openPopup(icao);
        }
      }
    });

    // pin button
    const pinBtn = card.querySelector('.pin-btn');
    if (pinBtn) {
      pinBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (aircraftData[icao]) {
          aircraftData[icao].pinned = !aircraftData[icao].pinned;
          renderSidebar();
        }
      });
    }

    // remove button
    const removeBtn = card.querySelector('.remove-btn');
    if (removeBtn) {
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeAircraft(icao);
      });
    }
  }

  async function removeAircraft(icao) {
    try {
      await fetch(`${API_BASE}/api/watchlist/remove`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: icao }),
      });
      showToast('✅ Removed', 'success');
    } catch (err) {
      console.warn('Remove API failed, removing locally:', err);
    }
    removeMarker(icao);
    if (activeIcao === icao) activeIcao = null;
    renderSidebar();
  }

  // ============================================================
  //  FIR BOUNDARIES LAYER
  // ============================================================

  let firLayer = null;
  let firDataLoaded = false;

  async function loadFIRBoundaries() {
    if (firDataLoaded) return;
    try {
      const res = await fetch('/fir_boundaries.json');
      if (!res.ok) return;
      const geojson = await res.json();
      firDataLoaded = true;
      console.log(`🗺️ Loaded ${geojson.features.length} country borders`);

      L.geoJSON(geojson, {
        style: () => ({
          color: '#5b9cf6',
          weight: 1.2,
          opacity: 0.6,
          fill: false,
        }),
        onEachFeature: (feature, layer) => {
          const name = feature.properties.name || feature.properties.NAME || '';
          layer.bindTooltip(name, {
            permanent: false,
            direction: 'center',
            className: 'fir-tooltip',
          });
        },
      }).addTo(firLayer);
    } catch (e) {
      console.warn('Could not load country borders:', e);
    }
  }

  // ============================================================
  //  NEARBY AIRCRAFT (Geofence)
  // ============================================================

  const nearbyMarkers = {}; // icao -> L.circleMarker

  function renderNearby(markersOnly) {
    const $section = document.getElementById('nearby-section');
    const $list = document.getElementById('nearby-list');
    const $count = document.getElementById('nearby-count');
    if (!$section || !$list) return;

    // Clean stale entries (older than 10 min)
    const now = Date.now();
    Object.keys(nearbyAircraft).forEach(k => {
      if (now - nearbyAircraft[k].ts > 600000) {
        delete nearbyAircraft[k];
        if (nearbyMarkers[k]) { map.removeLayer(nearbyMarkers[k]); delete nearbyMarkers[k]; }
      }
    });

    // Filter out aircraft already on the watchlist (prefer main list)
    const entries = Object.entries(nearbyAircraft).filter(([icao]) => !aircraftData[icao]);
    $section.style.display = entries.length ? 'flex' : 'none';
    $count.textContent = entries.length;

    // Update map dots
    entries.forEach(([icao, ac]) => {
      if (ac.lat && ac.lon) {
        // Build a pseudo-ac object for markerTooltip
        const tipAc = {
          registration: ac.reg || icao.toUpperCase(),
          icao24: icao,
          callsign: ac.callsign || '',
          operator: '',
          vertical_rate: ac.vr || 0,
          origin: ac.origin || null,
          destination: ac.destination || null,
        };
        const tip = markerTooltip(tipAc);
        if (nearbyMarkers[icao]) {
          nearbyMarkers[icao].setLatLng([ac.lat, ac.lon]);
          nearbyMarkers[icao].setTooltipContent(tip);
        } else {
          nearbyMarkers[icao] = L.circleMarker([ac.lat, ac.lon], {
            radius: 5,
            color: '#f59e0b',
            fillColor: '#f59e0b',
            fillOpacity: 0.8,
            weight: 2,
          }).addTo(map);
          nearbyMarkers[icao].bindTooltip(tip, { direction: 'top', offset: [0, -8], className: 'airport-tooltip' });
        }
      }
    });

    // Remove dots for aircraft no longer nearby OR already on watchlist
    Object.keys(nearbyMarkers).forEach(k => {
      if (!nearbyAircraft[k] || aircraftData[k]) {
        map.removeLayer(nearbyMarkers[k]);
        delete nearbyMarkers[k];
      }
    });

    // Throttle DOM list rebuild (heavy) — only every 3 seconds
    if (markersOnly) return;
    if (renderNearby._lastDOM && now - renderNearby._lastDOM < 3000) return;
    renderNearby._lastDOM = now;

    $list.innerHTML = entries.map(([icao, ac]) => {
      const vrArrow = ac.vr > 200 ? '<span class="nearby-vr climb">↑</span>'
                    : ac.vr < -200 ? '<span class="nearby-vr desc">↓</span>'
                    : '';
      return `
      <div class="nearby-card" data-icao="${icao}">
        <span class="nearby-dot"></span>
        <span class="nearby-reg">${ac.reg}</span>
        ${ac.callsign ? `<span class="nearby-cs">${ac.callsign}</span>` : ''}
        <span class="nearby-alt">${ac.alt ? Math.round(ac.alt).toLocaleString() + 'ft' : '—'}${vrArrow}</span>
      </div>`;
    }).join('');

    // Click to pan map
    $list.querySelectorAll('.nearby-card').forEach(card => {
      card.addEventListener('click', () => {
        const ac = nearbyAircraft[card.dataset.icao];
        if (ac?.lat && ac?.lon) map.panTo([ac.lat, ac.lon], { animate: true });
      });
    });
  }

  // ============================================================
  //  ADD AIRCRAFT
  // ============================================================

  async function addAircraft() {
    const val = $addInput.value.trim();
    if (!val) return;

    $addBtn.classList.add('loading');
    $addBtn.disabled = true;

    try {
      const res = await fetch(`${API_BASE}/api/watchlist/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: val }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.ok) {
        $addInput.value = '';
        const reg = body.entry?.registration || body.duplicate ? val : val;
        showToast(body.duplicate ? `⚠️ ${val} already in watchlist` : `✅ Added ${reg}`, body.duplicate ? 'warning' : 'success');
      } else {
        showToast(`❌ Could not find "${val}"`, 'error');
      }
    } catch (err) {
      showToast('❌ Connection error', 'error');
    } finally {
      $addBtn.classList.remove('loading');
      $addBtn.disabled = false;
      $addInput.focus();
    }
  }

  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    // Trigger animation
    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  // ============================================================
  //  WEBSOCKET
  // ============================================================

  function setConnStatus(state, text) {
    $conn.className = `conn-status ${state}`;
    $connLabel.textContent = text;
    // force re-render animation for connected
    if (state === 'connected') {
      $conn.style.animation = 'none';
      void $conn.offsetHeight; // reflow
      $conn.style.animation = '';
    }
  }

  function connectWS() {
    setConnStatus('reconnecting', 'Connecting…');

    try {
      ws = new WebSocket(WS_URL);
    } catch (err) {
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      setConnStatus('connected', 'Connected');
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    };

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        handleMessage(msg);
      } catch (err) {
        console.warn('WS parse error:', err);
      }
    };

    ws.onclose = () => {
      setConnStatus('disconnected', 'Disconnected');
      scheduleReconnect();
    };

    ws.onerror = () => {
      setConnStatus('disconnected', 'Connection error');
      ws.close();
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    setConnStatus('reconnecting', `Reconnecting in ${RECONNECT_MS / 1000}s…`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectWS();
    }, RECONNECT_MS);
  }

  function handleMessage(msg) {
    if (msg.type === 'update') {
      // Build a registration map from watchlist
      const regMap = {};
      if (Array.isArray(msg.watchlist)) {
        msg.watchlist.forEach(w => {
          const icao = (w.icao24 || '').toLowerCase();
          if (icao) regMap[icao] = w;
        });
      }

      // Collect all valid ICAOs
      const newIcaos = new Set();

      // Process aircraft state (object keyed by icao)
      if (msg.aircraft && typeof msg.aircraft === 'object') {
        Object.entries(msg.aircraft).forEach(([icao, ac]) => {
          newIcaos.add(icao);
          if (!aircraftData[icao]) {
            aircraftData[icao] = { data: {}, marker: null, trail: [], trailLine: null, trailSegments: [], pinned: false };
            if (document.getElementById('show-trails')?.checked) trailVisible.add(icao);
          }
          // Merge watchlist info (registration, details) into aircraft data
          const wl = regMap[icao];
          if (wl) {
            if (!ac.registration && wl.registration) ac.registration = wl.registration;
            if (wl.details?.model && !ac.model) ac.model = wl.details.model;
            if (wl.details?.operator) ac.operator = wl.details.operator;
          }
          aircraftData[icao].data = ac;
          createOrUpdateMarker(icao, ac);
        });
      }

      // Also add watchlist entries that aren't in aircraft state yet
      Object.keys(regMap).forEach(icao => {
        if (!newIcaos.has(icao)) {
          newIcaos.add(icao);
          if (!aircraftData[icao]) {
            aircraftData[icao] = { data: {}, marker: null, trail: [], trailLine: null, trailSegments: [], pinned: false };
          }
          const wl = regMap[icao];
          const existing = aircraftData[icao].data;
          if (!existing.registration && wl.registration) existing.registration = wl.registration;
          if (!existing.icao24) existing.icao24 = icao;
          existing.status = existing.status || 'Unknown';
        }
      });

      // Apply trail data from server
      if (msg.trails && typeof msg.trails === 'object') {
        Object.entries(msg.trails).forEach(([icao, points]) => {
          if (aircraftData[icao] && Array.isArray(points)) {
            aircraftData[icao].trail = points.map(p => [p.lat, p.lon]);
            // Update trail line if exists
            if (aircraftData[icao].trailLine) {
              aircraftData[icao].trailLine.setLatLngs(aircraftData[icao].trail);
            }
          }
        });
      }

      // Remove aircraft no longer in watchlist (unless pinned)
      Object.keys(aircraftData).forEach(icao => {
        if (!newIcaos.has(icao) && !aircraftData[icao].pinned) {
          removeMarker(icao);
        }
      });

      // Store weather data from server
      if (msg.weather && typeof msg.weather === 'object') {
        Object.assign(weatherData, msg.weather);
      }

      // Store runway history from server
      if (msg.runwayHistory && typeof msg.runwayHistory === 'object') {
        runwayHistoryData = msg.runwayHistory;
      }
      if (msg.favoriteAirports) {
        favoriteAirports = msg.favoriteAirports;
        renderFavChips();
      }
      if (msg.favAirportCoords) {
        favAirportCoords = msg.favAirportCoords;
      }

      // Update stats
      let airborne = 0, ground = 0;
      Object.values(aircraftData).forEach(ad => {
        const s = getStatus(ad.data);
        if (s === 'airborne') airborne++;
        else if (s === 'ground') ground++;
      });
      $statTotal.textContent = Object.keys(aircraftData).length;
      $statAirborne.textContent = airborne;
      $statGround.textContent = ground;

      renderSidebar();
      updateAirportMarkers();
      if (firstUpdate) { fitBounds(); firstUpdate = false; }
    }

    // handle other message types
    if (msg.type === 'watchlist' && Array.isArray(msg.data)) {
      const newIcaos = new Set();
      msg.data.forEach(ac => {
        const icao = ac.icao24 || ac.hex;
        if (!icao) return;
        newIcaos.add(icao);
        if (!aircraftData[icao]) {
          aircraftData[icao] = { data: {}, marker: null, trail: [], trailLine: null, trailSegments: [], pinned: false };
        }
        Object.assign(aircraftData[icao].data, ac);
        createOrUpdateMarker(icao, aircraftData[icao].data);
      });
      Object.keys(aircraftData).forEach(icao => {
        if (!newIcaos.has(icao) && !aircraftData[icao].pinned) {
          removeMarker(icao);
        }
      });
      renderSidebar();
    }

    // ATC transcription results
    if (msg.type === 'atc_transcript' && msg.text) {
      const $transcript = document.getElementById('atc-transcript');
      if ($transcript) {
        // Highlight matched callsigns in the text
        let html = msg.text;
        if (msg.callsigns && msg.callsigns.length > 0) {
          for (const match of msg.callsigns) {
            let highlighted = false;

            // Try 1: Full callsign in text (e.g. "ISR727")
            const csRegex = new RegExp(match.callsign.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
            if (csRegex.test(html)) {
              html = html.replace(csRegex, `<span class="atc-callsign-match">${match.callsign}</span>`);
              highlighted = true;
            }

            // Try 2: Airline name + number (e.g. "Israir 727", "El Al 292")
            if (!highlighted && match.airline) {
              const airlineRegex = new RegExp(match.airline.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\d+', 'gi');
              if (airlineRegex.test(html)) {
                html = html.replace(airlineRegex, `<span class="atc-callsign-match">${match.callsign}</span>`);
                highlighted = true;
              }
            }

            // Try 3: Just the flight number (e.g. "727", "292")
            if (!highlighted) {
              const numMatch = match.callsign.match(/\d+$/);
              if (numMatch) {
                const num = numMatch[0];
                // Replace first occurrence of this standalone number
                const numRegex = new RegExp('\\b' + num + '\\b');
                if (numRegex.test(html)) {
                  html = html.replace(numRegex, `<span class="atc-callsign-match">${match.callsign}</span>`);
                  highlighted = true;
                }
              }
            }

            // Pulse the aircraft marker on the map
            // Check tracked aircraft
            let pulsed = false;
            const entry = aircraftData[match.icao];
            if (entry && entry.marker) {
              const el = entry.marker.getElement();
              if (el) {
                el.classList.add('marker-talking');
                setTimeout(() => el.classList.remove('marker-talking'), 8000);
                pulsed = true;
              }
            }

            // Also check nearby markers
            if (!pulsed && window._nearbyMarkers) {
              for (const [hex, nm] of Object.entries(window._nearbyMarkers)) {
                if (hex === match.icao || (nm._callsign && nm._callsign === match.callsign)) {
                  const el = nm.getElement();
                  if (el) {
                    el.classList.add('marker-talking');
                    setTimeout(() => el.classList.remove('marker-talking'), 8000);
                    pulsed = true;
                  }
                  break;
                }
              }
            }
          }
        }

        // Add transcript line
        const line = document.createElement('div');
        line.className = 'atc-transcript-line';
        line.innerHTML = html;

        // Remove "press play" placeholder
        const empty = $transcript.querySelector('.atc-transcript-empty');
        if (empty) empty.remove();

        $transcript.appendChild(line);

        // Keep only last 20 lines
        while ($transcript.children.length > 20) {
          $transcript.removeChild($transcript.firstChild);
        }

        // Auto-scroll to bottom
        $transcript.scrollTop = $transcript.scrollHeight;
      }
    }

    // Geofence alerts (new entry)
    if (msg.type === 'geofence_alert' && msg.aircraft) {
      const ac = msg.aircraft;
      const key = ac.hex || ac.icao;
      nearbyAircraft[key] = {
        reg: ac.reg || ac.hex,
        callsign: ac.callsign || '',
        alt: ac.alt,
        gs: ac.gs,
        vr: ac.vr || 0,
        lat: ac.lat,
        lon: ac.lon,
        ts: Date.now(),
      };
      showToast(`✈️ ${ac.reg || ac.hex} entered radius${ac.callsign ? ' (' + ac.callsign + ')' : ''} — ${Math.round(ac.alt || 0)}ft`, 'warning');
      renderNearby();
    }

    // Geofence bulk position update (all nearby aircraft)
    if (msg.type === 'geofence_update' && msg.aircraft) {
      const currentKeys = new Set();
      for (const ac of msg.aircraft) {
        const key = ac.hex || ac.icao;
        currentKeys.add(key);
        if (nearbyAircraft[key]) {
          // Update existing
          nearbyAircraft[key].lat = ac.lat;
          nearbyAircraft[key].lon = ac.lon;
          nearbyAircraft[key].alt = ac.alt;
          nearbyAircraft[key].gs = ac.gs;
          nearbyAircraft[key].vr = ac.vr || 0;
          nearbyAircraft[key].callsign = ac.callsign || nearbyAircraft[key].callsign;
          nearbyAircraft[key].heading = ac.heading;
          nearbyAircraft[key].origin = ac.origin || nearbyAircraft[key].origin;
          nearbyAircraft[key].destination = ac.destination || nearbyAircraft[key].destination;
          nearbyAircraft[key].ts = Date.now();
        } else {
          // New (missed alert, or joined between polls)
          nearbyAircraft[key] = {
            reg: ac.reg || ac.hex,
            callsign: ac.callsign || '',
            alt: ac.alt, gs: ac.gs,
            vr: ac.vr || 0,
            lat: ac.lat, lon: ac.lon,
            heading: ac.heading,
            origin: ac.origin || null,
            destination: ac.destination || null,
            ts: Date.now(),
          };
        }
      }
      // Remove aircraft that left the radius
      Object.keys(nearbyAircraft).forEach(k => {
        if (!currentKeys.has(k)) {
          delete nearbyAircraft[k];
          if (nearbyMarkers[k]) { map.removeLayer(nearbyMarkers[k]); delete nearbyMarkers[k]; }
        }
      });
      renderNearby(true); // Fast: markers only, skip DOM rebuild
    }

    // Restore geofence state from server
    if (msg.geofence) {
      const gf = msg.geofence;
      const $gfEnabled = document.getElementById('geofence-enabled');
      const $gfRadiusGroup = document.getElementById('geofence-radius-group');
      const $gfCoordsGroup = document.getElementById('geofence-coords-group');
      const $gfPersistGroup = document.getElementById('geofence-persist-group');
      const $gfRadius = document.getElementById('geofence-radius');
      const $gfRadiusLabel = document.getElementById('geofence-radius-label');
      const $gfPick = document.getElementById('geofence-pick');

      // Auto-resume check: only run ONCE on first state after page load
      if (!gfPersistChecked && gf.enabled) {
        gfPersistChecked = true;
        const shouldPersist = localStorage.getItem('gfPersist') !== 'false';
        if (!shouldPersist) {
          // User doesn't want radius auto-resume — disable it
          $gfEnabled.checked = false;
          $gfRadiusGroup.style.display = 'none';
          $gfCoordsGroup.style.display = 'none';

          removeGeofenceCircle();
          fetch(`${API_BASE}/api/geofence`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: false }),
          }).catch(() => {});
          return; // skip the rest of geofence sync
        }
      }
      gfPersistChecked = true;

      if (gf.enabled && $gfEnabled) {
        $gfEnabled.checked = true;
        $gfRadiusGroup.style.display = 'flex';
        $gfCoordsGroup.style.display = 'flex';

        $gfRadius.value = gf.radiusNm;
        $gfRadiusLabel.textContent = gf.radiusNm + 'nm';
        $gfPick.textContent = `📍 ${gf.lat.toFixed(2)}, ${gf.lon.toFixed(2)}`;
        localStorage.setItem('gfLat', gf.lat);
        localStorage.setItem('gfLon', gf.lon);
        updateGeofenceCircle(gf.lat, gf.lon, gf.radiusNm);
      } else if (!gf.enabled && $gfEnabled) {
        $gfEnabled.checked = false;
        $gfRadiusGroup.style.display = 'none';
        $gfCoordsGroup.style.display = 'none';

        removeGeofenceCircle();
      }
    }

  }

  // ============================================================
  //  SIDEBAR TOGGLE
  // ============================================================

  function openSidebar() {
    $sidebar.classList.add('open');
    $toggle.classList.remove('visible');
    map.invalidateSize({ animate: true });
  }

  function closeSidebar() {
    $sidebar.classList.remove('open');
    $toggle.classList.add('visible');
    map.invalidateSize({ animate: true });
  }

  // ============================================================
  //  INIT
  // ============================================================

  const trailVisible = new Set(); // per-aircraft trail visibility
  let autoFit = localStorage.getItem('autoFit') === 'true';

  function init() {
    initMap();

    // Sidebar events
    $close.addEventListener('click', closeSidebar);
    $toggle.addEventListener('click', openSidebar);

    // Add aircraft
    $addBtn.addEventListener('click', addAircraft);
    $addInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') addAircraft();
    });

    // ---- Refresh button ----
    const $refreshBtn = document.getElementById('refresh-btn');
    $refreshBtn.addEventListener('click', async () => {
      $refreshBtn.classList.add('refreshing');
      try {
        await fetch(`${API_BASE}/api/poll`, { method: 'POST' });
      } catch (e) {}
      setTimeout(() => $refreshBtn.classList.remove('refreshing'), 1500);
    });

    // ---- Settings panel toggle ----
    const $settingsBtn = document.getElementById('settings-btn');
    const $settingsPanel = document.getElementById('settings-panel');
    $settingsBtn.addEventListener('click', () => {
      const isOpen = $settingsPanel.classList.toggle('open');
      $settingsBtn.classList.toggle('active', isOpen);
    });

    // ---- Layers panel ----
    const $layersBtn = document.getElementById('layers-btn');
    const $layersPanel = document.getElementById('layers-panel');
    $layersBtn.addEventListener('click', () => {
      const isOpen = $layersPanel.style.display === 'none';
      $layersPanel.style.display = isOpen ? 'block' : 'none';
      $layersBtn.classList.toggle('active', isOpen);
    });

    // ---- LiveATC audio player ----
    const $atcMapBtn = document.getElementById('atc-map-btn');
    const $atcPanel = document.getElementById('atc-panel');
    const $atcAudio = document.getElementById('atc-audio');
    const $atcPlay = document.getElementById('atc-play');
    const $atcStop = document.getElementById('atc-stop');
    const $atcFeed = document.getElementById('atc-feed');
    const $atcVolume = document.getElementById('atc-volume');
    const $atcStatus = document.getElementById('atc-status');

    $atcMapBtn.addEventListener('click', () => {
      const isOpen = $atcPanel.style.display !== 'none';
      $atcPanel.style.display = isOpen ? 'none' : 'block';
      if (!$atcMapBtn.classList.contains('live')) {
        $atcMapBtn.classList.toggle('active', !isOpen);
      }
      // Close layers panel when opening ATC
      if (!isOpen) {
        document.getElementById('layers-panel').style.display = 'none';
        document.getElementById('layers-btn').classList.remove('active');
      }
    });

    $atcAudio.volume = parseInt($atcVolume.value) / 100;

    $atcPlay.addEventListener('click', () => {
      const mount = $atcFeed.value;
      $atcAudio.src = `${API_BASE}/api/atc/${mount}?t=${Date.now()}`;
      $atcAudio.play().catch(() => {});
      $atcPlay.style.display = 'none';
      $atcStop.style.display = 'flex';
      $atcStatus.textContent = 'Connecting…';
      $atcStatus.className = 'atc-status';
    });

    $atcStop.addEventListener('click', () => {
      $atcAudio.pause();
      $atcAudio.src = '';
      $atcPlay.style.display = 'flex';
      $atcStop.style.display = 'none';
      $atcStatus.textContent = 'Stopped';
      $atcStatus.className = 'atc-status';
      $atcMapBtn.classList.remove('live');
      if ($atcPanel.style.display !== 'none') $atcMapBtn.classList.add('active');
    });

    $atcVolume.addEventListener('input', () => {
      $atcAudio.volume = parseInt($atcVolume.value) / 100;
    });

    $atcFeed.addEventListener('change', () => {
      if ($atcStop.style.display !== 'none') {
        const mount = $atcFeed.value;
        $atcAudio.src = `${API_BASE}/api/atc/${mount}?t=${Date.now()}`;
        $atcAudio.play().catch(() => {});
        $atcStatus.textContent = 'Connecting…';
        $atcStatus.className = 'atc-status';
      }
    });

    $atcAudio.addEventListener('playing', () => {
      $atcStatus.textContent = '● LIVE';
      $atcStatus.className = 'atc-status live';
      $atcMapBtn.classList.remove('active');
      $atcMapBtn.classList.add('live');
    });
    $atcAudio.addEventListener('waiting', () => {
      $atcStatus.textContent = 'Buffering…';
      $atcStatus.className = 'atc-status';
    });
    $atcAudio.addEventListener('error', () => {
      $atcStatus.textContent = 'Error';
      $atcStatus.className = 'atc-status';
      $atcPlay.style.display = 'flex';
      $atcStop.style.display = 'none';
      $atcMapBtn.classList.remove('live');
    });

    // ---- Text D-ATIS Fetch ----
    const $datisInput = document.getElementById('datis-input');
    const $datisBtn = document.getElementById('datis-fetch-btn');
    const $datisSumBtn = document.getElementById('datis-sum-btn');
    const $datisRes = document.getElementById('datis-result');
    if ($datisInput && $datisBtn && $datisRes) {
      let lastAtisText = '';
      
      $datisBtn.addEventListener('click', async () => {
        const icao = $datisInput.value.trim().toUpperCase();
        if (icao.length < 3) return;
        $datisRes.style.display = 'block';
        $datisRes.textContent = 'Fetching D-ATIS for ' + icao + '...';
        if ($datisSumBtn) $datisSumBtn.style.display = 'none';
        
        try {
          const r = await fetch(`${API_BASE}/api/atis/${icao}`);
          const data = await r.json();
          if (!r.ok) {
            $datisRes.textContent = data.error || 'Failed to fetch ATIS.';
            return;
          }
          let out = ``;
          if (data.combined) out += `\n${data.combined}`;
          if (data.arr) out += `\nARR: ${data.arr}`;
          if (data.dep) out += `\nDEP: ${data.dep}`;
          
          lastAtisText = out.trim();
          $datisRes.textContent = lastAtisText || 'No ATIS content found.';
          if (lastAtisText && $datisSumBtn) $datisSumBtn.style.display = 'block';
        } catch (e) {
          $datisRes.textContent = 'Network error fetching ATIS.';
        }
      });
      
      if ($datisSumBtn) {
        $datisSumBtn.addEventListener('click', async () => {
          if (!lastAtisText) return;
          const origText = $datisRes.textContent;
          $datisRes.textContent = '✨ AI Summarizing...\n\n' + origText;
          try {
            const r = await fetch(`${API_BASE}/api/atis/summarize`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: lastAtisText })
            });
            const data = await r.json();
            if (r.ok && data.summary) {
              $datisRes.innerHTML = `<div style="color:#fff; margin-bottom:8px;"><b>AI Summary:</b><br>${data.summary.replace(/\n/g, '<br>')}</div><hr style="border-color:rgba(255,255,255,0.1)"><div style="color:var(--text-muted)">${origText}</div>`;
            } else {
              $datisRes.textContent = 'Failed to summarize: ' + (data.error || 'Unknown error') + '\n\n' + origText;
            }
          } catch (e) {
            $datisRes.textContent = 'Error summarizing.\n\n' + origText;
          }
        });
      }
      
      $datisInput.addEventListener('keyup', (e) => {
        if (e.key === 'Enter') $datisBtn.click();
      });
    }

    // ---- Poll interval slider ----
    const $pollRange = document.getElementById('poll-interval');
    const $pollLabel = document.getElementById('poll-interval-label');
    const savedInterval = localStorage.getItem('pollInterval');
    if (savedInterval) {
      $pollRange.value = savedInterval;
      $pollLabel.textContent = savedInterval + 's';
    }
    $pollRange.addEventListener('input', () => {
      $pollLabel.textContent = $pollRange.value + 's';
    });
    $pollRange.addEventListener('change', async () => {
      const val = parseInt($pollRange.value);
      localStorage.setItem('pollInterval', val);
      try {
        await fetch(`${API_BASE}/api/settings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pollInterval: val }),
        });
      } catch (e) {}
    });

    // ---- Map style selector ----
    const $mapStyle = document.getElementById('map-style');
    const savedStyle = localStorage.getItem('mapStyle') || 'dark';
    $mapStyle.value = savedStyle;
    $mapStyle.addEventListener('change', () => {
      setMapStyle($mapStyle.value);
    });

    // ---- Show trails toggle (master show-all / hide-all) ----
    const $showTrails = document.getElementById('show-trails');
    const trailDefault = localStorage.getItem('showTrails') !== 'false'; // default ON
    $showTrails.checked = trailDefault;
    if (trailDefault) {
      Object.entries(aircraftData).forEach(([icao, ad]) => {
        trailVisible.add(icao);
        if (ad.trailLine) ad.trailLine.addTo(map);
      });
    }
    $showTrails.addEventListener('change', () => {
      localStorage.setItem('showTrails', $showTrails.checked);
      if ($showTrails.checked) {
        // Show all trails
        Object.entries(aircraftData).forEach(([icao, ad]) => {
          trailVisible.add(icao);
          if (ad.trailLine) ad.trailLine.addTo(map);
        });
      } else {
        // Hide all trails
        trailVisible.clear();
        Object.values(aircraftData).forEach(ad => {
          if (ad.trailLine) map.removeLayer(ad.trailLine);
        });
      }
    });

    // ---- Auto-fit bounds ----
    const $autoFit = document.getElementById('auto-fit');
    $autoFit.checked = autoFit;
    $autoFit.addEventListener('change', () => {
      autoFit = $autoFit.checked;
      localStorage.setItem('autoFit', autoFit);
      if (autoFit) fitBounds();
    });

    // ---- Waypoint layer toggles ----
    const wpToggles = [
      { id: 'show-fixes', key: 'showFixes', cat: 'FIX' },
      { id: 'show-vor',   key: 'showVOR',   cat: 'VOR' },
      { id: 'show-ndb',   key: 'showNDB',   cat: 'NDB' },
      { id: 'show-dme',   key: 'showDME',   cat: 'DME' },
    ];
    wpToggles.forEach(({ id, key, cat }) => {
      const $el = document.getElementById(id);
      if (!$el) return;
      $el.checked = localStorage.getItem(key) === 'true';
      $el.addEventListener('change', () => {
        localStorage.setItem(key, $el.checked);
        if ($el.checked) {
          wpLayers[cat].addTo(map);
          renderedWpBounds = null; // force re-render
          renderWaypointsInView();
        } else {
          map.removeLayer(wpLayers[cat]);
        }
      });
    });

    // ---- Sort dropdown ----
    const $sortSelect = document.getElementById('sort-select');
    const savedSort = localStorage.getItem('sortMode');
    if (savedSort) $sortSelect.value = savedSort;
    $sortSelect.addEventListener('change', () => {
      localStorage.setItem('sortMode', $sortSelect.value);
      renderSidebar();
    });

    // ---- FIR Boundaries toggle ----
    const $showFIR = document.getElementById('show-fir');
    $showFIR.checked = localStorage.getItem('showFIR') === 'true';
    $showFIR.addEventListener('change', () => {
      const on = $showFIR.checked;
      localStorage.setItem('showFIR', on);
      if (on) {
        firLayer.addTo(map);
        loadFIRBoundaries();
      } else {
        map.removeLayer(firLayer);
      }
    });

    // ---- NAT Tracks toggle ----
    const $showNAT = document.getElementById('show-nat');
    $showNAT.checked = localStorage.getItem('showNAT') === 'true';
    $showNAT.addEventListener('change', () => {
      const on = $showNAT.checked;
      localStorage.setItem('showNAT', on);
      if (on) {
        natLayer.addTo(map);
        loadNATTracks();
      } else {
        map.removeLayer(natLayer);
      }
    });



    // ---- Phone Push Notifications ----
    const $pushBtn = document.getElementById('push-subscribe-btn');
    if ($pushBtn) {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        $pushBtn.textContent = 'Not Supported';
        $pushBtn.disabled = true;
      } else {
        $pushBtn.addEventListener('click', async () => {
          $pushBtn.textContent = 'Requesting...';
          try {
            const permission = await Notification.requestPermission();
            if (permission !== 'granted') {
              $pushBtn.textContent = 'Denied';
              return;
            }
            const swReg = await navigator.serviceWorker.register('/sw.js');
            const vapidRes = await fetch(`${API_BASE}/api/vapidPublicKey`);
            const { publicKey } = await vapidRes.json();
            if (!publicKey) {
              $pushBtn.textContent = 'No VAPID Key';
              return;
            }
            
            const urlBase64ToUint8Array = (base64String) => {
              const padding = '='.repeat((4 - base64String.length % 4) % 4);
              const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
              const rawData = window.atob(base64);
              const outputArray = new Uint8Array(rawData.length);
              for (let i = 0; i < rawData.length; ++i) {
                outputArray[i] = rawData.charCodeAt(i);
              }
              return outputArray;
            };

            const subscription = await swReg.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: urlBase64ToUint8Array(publicKey)
            });

            await fetch(`${API_BASE}/api/notifications/subscribe`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(subscription)
            });

            $pushBtn.textContent = 'Enabled';
            $pushBtn.style.background = '#10b981';
            $pushBtn.style.borderColor = '#059669';
          } catch (e) {
            console.error('Push subscription failed:', e);
            $pushBtn.textContent = 'Error';
          }
        });
      }
    }

    // ---- Geo-fence ----
    const $gfEnabled = document.getElementById('geofence-enabled');
    const $gfRadiusGroup = document.getElementById('geofence-radius-group');
    const $gfCoordsGroup = document.getElementById('geofence-coords-group');
    const $gfRadius = document.getElementById('geofence-radius');
    const $gfRadiusLabel = document.getElementById('geofence-radius-label');
    const $gfPick = document.getElementById('geofence-pick');
    let pickingCenter = false;

    async function sendGeofenceConfig(cfg) {
      try {
        await fetch(`${API_BASE}/api/geofence`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(cfg),
        });
      } catch (e) {}
    }

    const $gfPersistGroup = document.getElementById('geofence-persist-group');
    const $gfPersist = document.getElementById('geofence-persist');
    // Restore persist preference
    const savedPersist = localStorage.getItem('gfPersist') !== 'false';
    if ($gfPersist) $gfPersist.checked = savedPersist;

    $gfEnabled.addEventListener('change', async () => {
      const enabled = $gfEnabled.checked;
      $gfRadiusGroup.style.display = enabled ? 'flex' : 'none';
      $gfCoordsGroup.style.display = enabled ? 'flex' : 'none';

      if (enabled) {
        // Auto-enter pick mode so the user sets the center immediately
        pickingCenter = true;
        $gfPick.classList.add('picking');
        $gfPick.textContent = '🎯 Click the map to set center...';
        map.getContainer().style.cursor = 'crosshair';
        showToast('🎯 Click the map to set the radius center', 'info');
      } else {
        pickingCenter = false;
        $gfPick.classList.remove('picking');
        $gfPick.textContent = '📍 Pick from map';
        map.getContainer().style.cursor = '';
        removeGeofenceCircle();
        await sendGeofenceConfig({ enabled: false });
        showToast('Radius alerts disabled', 'info');
      }
    });

    // Keep on Refresh toggle — just saves preference
    if ($gfPersist) {
      $gfPersist.addEventListener('change', () => {
        localStorage.setItem('gfPersist', $gfPersist.checked);
      });
    }

    $gfRadius.addEventListener('input', () => {
      $gfRadiusLabel.textContent = $gfRadius.value + 'nm';
    });
    $gfRadius.addEventListener('change', async () => {
      const r = parseInt($gfRadius.value);
      if (geofenceCircle) {
        geofenceCircle.setRadius(r * 1852);
      }
      await sendGeofenceConfig({ radiusNm: r });
    });

    $gfPick.addEventListener('click', () => {
      pickingCenter = !pickingCenter;
      $gfPick.classList.toggle('picking', pickingCenter);
      $gfPick.textContent = pickingCenter ? '🎯 Click the map...' : '📍 Pick from map';
      if (pickingCenter) {
        map.getContainer().style.cursor = 'crosshair';
      } else {
        map.getContainer().style.cursor = '';
      }
    });

    map.on('click', async (e) => {
      if (!pickingCenter) return;
      const { lat, lng } = e.latlng;
      pickingCenter = false;
      $gfPick.classList.remove('picking');
      $gfPick.textContent = `📍 ${lat.toFixed(2)}, ${lng.toFixed(2)}`;
      map.getContainer().style.cursor = '';
      localStorage.setItem('gfLat', lat);
      localStorage.setItem('gfLon', lng);
      const r = parseInt($gfRadius.value);
      updateGeofenceCircle(lat, lng, r);
      // Now actually enable the geofence on the server with the picked location
      await sendGeofenceConfig({ enabled: true, lat, lon: lng, radiusNm: r });
      showToast(`📍 Radius active — ${lat.toFixed(3)}, ${lng.toFixed(3)} r=${r}nm`, 'success');
    });

    // initial render
    renderSidebar();

    // ---- Favorite Airports ----
    const $favInput = document.getElementById('fav-airport-input');
    const $favAddBtn = document.getElementById('fav-airport-add');
    const $favList = document.getElementById('fav-airport-list');

    async function addFavorite() {
      const code = ($favInput.value || '').toUpperCase().trim();
      if (!code || code.length < 2) return;
      $favInput.value = '';
      try {
        await fetch(`${API_BASE}/api/favorites`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ add: code }),
        });
      } catch (e) {}
    }

    async function removeFavorite(code) {
      try {
        await fetch(`${API_BASE}/api/favorites`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ remove: code }),
        });
      } catch (e) {}
    }

    if ($favAddBtn) $favAddBtn.addEventListener('click', addFavorite);
    if ($favInput) $favInput.addEventListener('keydown', e => { if (e.key === 'Enter') addFavorite(); });

    // Connect
    connectWS();
  }

  // run
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
