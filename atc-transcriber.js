/**
 * ATC Audio Transcriber — Deepgram Nova-3
 * Uses Deepgram's cloud API with keyterm prompting for ATC radio.
 * Superior noise handling + unlimited vocabulary boosting.
 * 
 * Falls back to Groq Whisper if Deepgram key not set.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

// ── State ──
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const USE_DEEPGRAM = !!DEEPGRAM_API_KEY;

let isReady = false;
let audioBuffer = [];
let lastTranscribeTime = 0;
const CHUNK_DURATION_MS = 4000; // 4 seconds — faster processing
const tmpDir = path.join(os.tmpdir(), 'atc-whisper');

// ── Airline callsign mapping (ICAO telephony → ICAO code) ──
const AIRLINE_MAP = {
  'el al': 'ELY', 'elal': 'ELY', 'el a': 'ELY', 'ela ': 'ELY',
  'ei ': 'ELY', 'ely': 'ELY', 'ely ': 'ELY', 'ally': 'ELY',
  'lal ': 'ELY', 'lal': 'ELY', 'elab': 'ELY', 'la al': 'ELY', 'lr': 'ELY',
  'targ': 'TGT',
  'speedbird': 'BAW',
  'lufthansa': 'DLH',
  'air france': 'AFR',
  'delta air': 'DAL', 'delta airlines': 'DAL',
  'united': 'UAL',
  'american': 'AAL',
  'ryanair': 'RYR',
  'easyjet': 'EZY',
  'turkish': 'THY',
  'emirates': 'UAE',
  'qatar': 'QTR',
  'etihad': 'ETD',
  'swiss': 'SWR',
  'austrian': 'AUA',
  'klm': 'KLM',
  'iberia': 'IBE',
  'alitalia': 'AZA',
  'scandinavian': 'SAS',
  'finnair': 'FIN',
  'lot': 'LOT', 'lot polish': 'LOT',
  'aegean': 'AEE',
  'olympic': 'OAL',
  'arkia': 'AIZ',
  'israir': 'ISR',
  'up air': 'LLW',
  'sun door': 'ERA', 'sundor': 'ERA',
  'cathay': 'CPA',
  'singapore': 'SIA',
  'korean': 'KAL', 'korean air': 'KAL',
  'japan air': 'JAL', 'japan airlines': 'JAL', 'japan': 'JAL',
  'ana': 'ANA',
  'air canada': 'ACA',
  'westjet': 'WJA',
  'southwest': 'SWA',
  'jetblue': 'JBU',
  'spirit': 'NKS',
  'frontier': 'FFT',
  'wizz': 'WZZ', 'wizzair': 'WZZ',
  'vueling': 'VLG',
  'norwegian': 'NAX',
  'transavia': 'TRA',
  'pegasus': 'PGT',
  'air india': 'AIC',
  'virgin': 'VIR', 'virgin atlantic': 'VIR',
  'aeroflot': 'AFL',
  'air china': 'CCA',
  'china southern': 'CSN',
  'china eastern': 'CES',
  'condor': 'CFG',
  'eurowings': 'EWG',
  'tap': 'TAP', 'tap air': 'TAP',
  'aer lingus': 'EIN',
  'royal jordanian': 'RJA',
  'middle east': 'MEA',
  'saudia': 'SVA', 'saudi': 'SVA',
  'flynas': 'KNE',
  'gulf air': 'GFA',
  'oman air': 'OMA',
  'smartwings': 'TVS',
  'volotea': 'VOE',
  'czech': 'CSA',
  'cargo lux': 'CLX', 'cargolux': 'CLX',
  'fedex': 'FDX',
  'ups': 'UPS',
  'atlas': 'GTI', 'atlas air': 'GTI',
  'cal cargo': 'ICL',
};

// ── Number word → digit mapping ──
const NUM_WORDS = {
  'zero': '0', 'oh': '0', 'o': '0',
  'one': '1', 'won': '1',
  'two': '2', 'to': '2', 'too': '2',
  'three': '3', 'tree': '3',
  'four': '4', 'for': '4',
  'five': '5', 'fife': '5',
  'six': '6',
  'seven': '7',
  'eight': '8',
  'nine': '9', 'niner': '9',
};

/**
 * Initialize
 */
async function init() {
  if (!DEEPGRAM_API_KEY && !GROQ_API_KEY) {
    console.error('❌ No DEEPGRAM_API_KEY or GROQ_API_KEY set — ATC transcription disabled');
    return;
  }
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  isReady = true;
  if (USE_DEEPGRAM) {
    console.log('✅ Deepgram Nova-3 ready — ATC transcription active (best quality)');
  } else {
    console.log('✅ Groq Whisper Large V3 ready — ATC transcription active');
    console.log('💡 For better accuracy, add DEEPGRAM_API_KEY (free $200 credit at deepgram.com)');
  }
}

function feedAudio(chunk) {
  if (!isReady) return;
  audioBuffer.push(Buffer.from(chunk));
}

/**
 * Build keyterms for Deepgram from active aircraft + waypoints
 */
function buildKeyterms(aircraftState, nearbyAircraft) {
  // PRIORITY: Callsigns first! That's the whole point — identify WHO is talking.
  // Deepgram already knows "runway", "cleared", "descend" — it doesn't know "El Al 292"
  const terms = [];
  const seen = new Set();

  const ICAO_TO_SPOKEN = {
    'ELY': 'El Al', 'AIZ': 'Arkia', 'ISR': 'Israir', 'ERA': 'Sun D\'Or',
    'THY': 'Turkish', 'AEE': 'Aegean', 'RYR': 'Ryanair', 'WZZ': 'Wizz Air',
    'EZY': 'EasyJet', 'DLH': 'Lufthansa', 'BAW': 'Speedbird',
    'UAE': 'Emirates', 'QTR': 'Qatar', 'ETD': 'Etihad',
    'SWR': 'Swiss', 'AUA': 'Austrian', 'KLM': 'KLM',
    'DAL': 'Delta', 'UAL': 'United', 'AAL': 'American',
    'LOT': 'LOT', 'FIN': 'Finnair', 'SAS': 'Scandinavian',
    'AFR': 'Air France', 'IBE': 'Iberia', 'AZA': 'Alitalia',
    'LLW': 'Up', 'TGT': 'Targ', 'OAL': 'Olympic',
    'CFG': 'Condor', 'EWG': 'Eurowings', 'PGT': 'Pegasus',
    'FDX': 'FedEx', 'CLX': 'Cargolux', 'JAL': 'Japan Airlines',
    'RJA': 'Royal Jordanian', 'MEA': 'Middle East',
    'BBG': 'Blue Bird', 'TRA': 'Transavia', 'TVS': 'SmartWings',
    'VOE': 'Volotea', 'VLG': 'Vueling', 'NKS': 'Spirit',
  };

  function callsignToSpoken(cs) {
    const match = cs.match(/^([A-Z]{2,3})(\d+)$/);
    if (match) {
      const airline = ICAO_TO_SPOKEN[match[1]];
      if (airline) return `${airline} ${match[2]}`;
    }
    return cs;
  }

  function addTerm(t) {
    if (!seen.has(t)) { seen.add(t); terms.push(t); }
  }

  // ── #1: Spoken callsigns from ALL aircraft in area ──
  if (aircraftState) {
    for (const state of Object.values(aircraftState)) {
      if (state.callsign) addTerm(callsignToSpoken(state.callsign));
    }
  }
  if (nearbyAircraft) {
    for (const ac of Object.values(nearbyAircraft)) {
      if (ac.callsign) addTerm(callsignToSpoken(ac.callsign));
    }
  }

  // ── #2: Airline names (helps Deepgram recognize the airline part) ──
  for (const name of [
    'El Al', 'Arkia', 'Israir', 'Blue Bird', 'Sun D\'Or',
    'Turkish', 'Aegean', 'Ryanair', 'Lufthansa', 'Speedbird',
    'Emirates', 'FedEx', 'LOT', 'Wizz Air',
  ]) addTerm(name);

  // ── #3: Only terms Deepgram WON'T know (non-English) ──
  for (const t of [
    'QNH', 'ILS', 'squawk', 'wilco', 'niner', 'ATIS',
    'Nicosia', 'Amman', 'Ben Gurion',
    'Shalom', 'Toda', 'Lehitraot', 'Boker Tov', 'Erev Tov',
    'DAFNA', 'BALMA', 'LATKA', 'DOROT', 'AMMOS', 'VETEK',
    'SUVAS', 'NATBG', 'APLON', 'BURGA', 'GISHU',
  ]) addTerm(t);

  // Each spoken callsign like "El Al 292" = ~8-10 subword tokens
  // Max 30 terms to stay safely under Deepgram's 500 token limit
  return terms.slice(0, 30);
}

/**
 * Transcribe via Deepgram Nova-3
 */
async function transcribeDeepgram(audioData, keyterms) {
  // Build query params
  const params = new URLSearchParams({
    model: 'nova-3',
    language: 'en',
    smart_format: 'true',
    punctuate: 'true',
    utterances: 'false',
  });

  // Add keyterms (Deepgram's vocabulary boosting)
  if (keyterms.length > 0) {
    // Feed ALL terms to Deepgram
    for (const term of keyterms.slice(0, 500)) {
      params.append('keyterm', term);
    }
  }

  const url = `https://api.deepgram.com/v1/listen?${params.toString()}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Token ${DEEPGRAM_API_KEY}`,
      'Content-Type': 'audio/mp3',
    },
    body: audioData,
  });

  if (!response.ok) {
    const err = await response.text();
    console.error(`🎙️ Deepgram error ${response.status}: ${err}`);
    return null;
  }

  const result = await response.json();
  const alt = result?.results?.channels?.[0]?.alternatives?.[0];
  if (!alt) return null;

  const text = (alt.transcript || '').trim();
  const confidence = alt.confidence || 0;

  // Skip low-confidence results (silence/noise)
  if (confidence < 0.3 || !text) return null;

  return { text, confidence };
}

/**
 * Transcribe via Groq Whisper (fallback)
 */
async function transcribeGroq(audioData, aircraftState, nearbyAircraft) {
  const boundary = '----ATC' + Date.now();
  const formParts = [];

  formParts.push(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="chunk.mp3"\r\n` +
    `Content-Type: audio/mpeg\r\n\r\n`
  );
  formParts.push(audioData);
  formParts.push('\r\n');

  formParts.push(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="model"\r\n\r\n` +
    `whisper-large-v3\r\n`
  );

  formParts.push(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="language"\r\n\r\n` +
    `en\r\n`
  );

  // Build prompt
  const activeCallsigns = [];
  if (aircraftState) {
    for (const state of Object.values(aircraftState)) {
      if (state.callsign) activeCallsigns.push(state.callsign);
    }
  }
  if (nearbyAircraft) {
    for (const ac of Object.values(nearbyAircraft)) {
      if (ac.callsign) activeCallsigns.push(ac.callsign);
    }
  }
  const callsignList = activeCallsigns.slice(0, 15).join(', ');
  let waypointStr = '';
  try {
    const wpData = fs.readFileSync(path.join(__dirname, 'waypoints.txt'), 'utf8').trim();
    const allWp = wpData.split(',').map(w => w.trim()).filter(w => w.length >= 3);
    waypointStr = ` Waypoints: ${allWp.slice(0, 20).join(', ')}.`;
  } catch (e) {}

  const atcPrompt = [
    `ATC radio communication. Tower, Approach, Ground, Departure, Radar, Control.`,
    callsignList ? `Active callsigns: ${callsignList}.` : '',
    `Airlines: El Al, Arkia, Israir, Turkish, Aegean, Ryanair, Wizz Air, Lufthansa,`,
    `Speedbird, Emirates, Qatar, Delta, United, American, Air France, KLM, Swiss, Sun D'Or.`,
    `Contact Nicosia, Cairo, Amman, Ankara, Athens, Larnaca, Eurocontrol.`,
    `Shalom, Toda, Erev Tov, Boker Tov, Shavua Tov, Bevakasha, Lehitraot.${waypointStr}`,
    `Cleared takeoff, cleared land, cleared ILS approach, line up wait, taxi holding point,`,
    `climb flight level, descend, maintain altitude, heading, direct to, squawk, QNH,`,
    `contact tower on, contact approach on, roger, wilco, affirm, negative, good day.`,
  ].filter(Boolean).join(' ').slice(0, 890);

  formParts.push(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="prompt"\r\n\r\n` +
    `${atcPrompt}\r\n`
  );

  formParts.push(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="temperature"\r\n\r\n` +
    `0\r\n`
  );

  formParts.push(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="response_format"\r\n\r\n` +
    `verbose_json\r\n`
  );

  formParts.push(`--${boundary}--\r\n`);

  const body = Buffer.concat(
    formParts.map(p => typeof p === 'string' ? Buffer.from(p) : p)
  );

  const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GROQ_API_KEY}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  if (!response.ok) {
    const err = await response.text();
    console.error(`🎙️ Groq error ${response.status}: ${err}`);
    return null;
  }

  const result = await response.json();

  // Filter by no_speech_prob
  let text = '';
  if (result?.segments && Array.isArray(result.segments)) {
    const goodSegments = result.segments.filter(seg => (seg.no_speech_prob || 0) < 0.7);
    text = goodSegments.map(seg => seg.text).join(' ').trim();
    if (result.segments.length > 0 && goodSegments.length === 0) return null;
  } else {
    text = (result?.text || '').trim();
  }

  return text ? { text, confidence: 0.7 } : null;
}

/**
 * Main tick — transcribe buffered audio
 */
async function tick(aircraftState, nearbyAircraft) {
  if (!isReady || audioBuffer.length === 0) return null;

  const now = Date.now();
  if (now - lastTranscribeTime < CHUNK_DURATION_MS) return null;
  lastTranscribeTime = now;

  const chunks = audioBuffer.splice(0);
  const mp3Data = Buffer.concat(chunks);
  if (mp3Data.length < 2000) return null;

  try {
    // FFmpeg preprocessing — clean ATC radio audio
    const rawPath = path.join(tmpDir, `raw_${now}.mp3`);
    const cleanPath = path.join(tmpDir, `clean_${now}.mp3`);
    fs.writeFileSync(rawPath, mp3Data);

    let sendData = mp3Data;
    try {
      execFileSync('ffmpeg', [
        '-i', rawPath, '-y',
        '-af', 'highpass=f=200,lowpass=f=4000,compand=attacks=0.01:decays=0.3:points=-80/-80|-45/-25|-27/-15|0/-10,loudnorm=I=-16:TP=-1.5:LRA=11',
        '-ar', '16000', '-ac', '1',
        cleanPath,
      ], { timeout: 5000, stdio: 'ignore' });
      sendData = fs.readFileSync(cleanPath);
      try { fs.unlinkSync(cleanPath); } catch (e) {}
    } catch (e) {}
    try { fs.unlinkSync(rawPath); } catch (e) {}

    // Transcribe
    const t0 = Date.now();
    let result;

    if (USE_DEEPGRAM) {
      const keyterms = buildKeyterms(aircraftState, nearbyAircraft);
      result = await transcribeDeepgram(sendData, keyterms);
    } else {
      result = await transcribeGroq(sendData, aircraftState, nearbyAircraft);
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    if (!result) {
      return null;
    }

    let text = result.text;

    // Post-process
    text = postProcessTranscript(text);
    const provider = USE_DEEPGRAM ? 'DG' : 'GQ';
    console.log(`🎙️ [${elapsed}s|${provider}] "${text}"`);

    isTranscribing = false;

    // Filter junk
    if (!text || text.length < 3) return null;

    const junkExact = ['.', '-', '♪', 'you', 'yeah', 'yes', 'no', 'hmm',
      'okay', 'bye', 'next', 'the end', '...'];
    if (junkExact.includes(text.toLowerCase())) return null;

    const junkContains = [
      'thank you for watching', 'thanks for watching', 'subscribe',
      'closed caption', 'subtitle', 'kris brandhagen', 'brandhagen',
      '[music]', '[blank_audio]', '[inaudible]', '[silence]',
      '*unintelligible*', '(music)', '(silence)', 'thank you for listening',
      'like and subscribe', 'comment below', 'see you next',
      'captioning provided', 'disability access', 'oregon state',
      'transcription by', 'translation by',
    ];
    const lower = text.toLowerCase();
    if (junkContains.some(j => lower.includes(j))) return null;

    // Repetition detection (words)
    const words = lower.replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
    if (words.length > 5) {
      const freq = {};
      for (const w of words) { freq[w] = (freq[w] || 0) + 1; }
      const maxFreq = Math.max(...Object.values(freq));
      if (maxFreq / words.length > 0.4) return null;
    }
    if (text.length > 300) return null;

    // Phrase repetition detection
    for (const n of [3, 4, 5]) {
      if (words.length < n * 2) continue;
      const phrases = {};
      for (let i = 0; i <= words.length - n; i++) {
        const phrase = words.slice(i, i + n).join(' ');
        phrases[phrase] = (phrases[phrase] || 0) + 1;
      }
      if (Math.max(...Object.values(phrases)) >= 3) return null;
    }

    // Prompt echo detection (Groq only)
    if (!USE_DEEPGRAM) {
      const promptEchoWords = new Set([
        'direct', 'wait', 'takeoff', 'roger', 'ils', 'qnh', 'cleared', 'tower',
        'approach', 'ground', 'departure', 'radar', 'control', 'contact', 'climb',
        'descend', 'maintain', 'heading', 'squawk', 'wilco', 'affirm', 'negative',
        'altitude', 'flight', 'level', 'land', 'taxi', 'holding', 'point', 'line',
        'up', 'and', 'on', 'to', 'the', 'a', 'for', 'good', 'day',
      ]);
      const contentWords = words.filter(w => w.length > 1 && !promptEchoWords.has(w));
      if (words.length >= 4 && contentWords.length / words.length < 0.3) return null;
    }

    // Extract callsigns
    const callsigns = extractCallsigns(text, aircraftState, nearbyAircraft);

    if (callsigns.length > 0) {
      console.log(`🎙️ Matched:`, callsigns.map(c =>
        `${c.callsign}(${c.position}${c.icao ? '' : '?'})`
      ).join(', '));
    }

    return { text, callsigns, timestamp: now };
  } catch (e) {
    console.error('🎙️ Transcription error:', e.message);
    return null;
  }
}

/**
 * Extract callsigns from transcribed text
 */
function extractCallsigns(text, aircraftState, nearbyAircraft) {
  const matches = [];
  const lowerText = text.toLowerCase();
  const textLen = lowerText.length;

  const knownCallsigns = {};
  if (aircraftState) {
    for (const [icao, state] of Object.entries(aircraftState)) {
      if (state.callsign) knownCallsigns[state.callsign.toUpperCase()] = icao;
    }
  }
  if (nearbyAircraft) {
    for (const [icao, ac] of Object.entries(nearbyAircraft)) {
      if (ac.callsign) knownCallsigns[ac.callsign.toUpperCase()] = icao;
    }
  }

  function addMatch(callsign, icao, confidence, position) {
    if (!matches.find(m => m.callsign === callsign)) {
      matches.push({ callsign, icao, confidence, position });
    }
  }

  function getPosition(idx, matchLen) {
    const center = idx + matchLen / 2;
    if (center < textLen * 0.35) return 'start';
    if (center > textLen * 0.65) return 'end';
    return 'middle';
  }

  // Method 1: Airline name + flight number (forward & backward)
  for (const [airlineName, icaoCode] of Object.entries(AIRLINE_MAP)) {
    let searchFrom = 0;
    while (true) {
      const idx = lowerText.indexOf(airlineName, searchFrom);
      if (idx === -1) break;
      searchFrom = idx + 1;

      const afterAirline = lowerText.slice(idx + airlineName.length).trim();
      let flightNum = extractFlightNumber(afterAirline);

      if (!flightNum) {
        const beforeAirline = lowerText.slice(Math.max(0, idx - 20), idx).trim();
        const beforeWords = beforeAirline.split(/[\s,]+/).filter(Boolean);
        flightNum = extractFlightNumberFromEnd(beforeWords);
      }

      if (flightNum) {
        const callsign = icaoCode + flightNum;
        // Only match if this callsign actually exists in ADS-B data
        if (knownCallsigns[callsign]) {
          addMatch(callsign, knownCallsigns[callsign], 0.85, getPosition(idx, airlineName.length));
        }
      }
    }
  }

  // Method 2: Direct callsign match
  for (const [callsign, icao] of Object.entries(knownCallsigns)) {
    const csLower = callsign.toLowerCase();
    const idx = lowerText.indexOf(csLower);
    if (idx !== -1) {
      addMatch(callsign, icao, 0.95, getPosition(idx, callsign.length));
    }
    if (/^([A-Z]{2,3})(\d+)$/.test(callsign)) {
      const prefix = RegExp.$1.toLowerCase();
      const num = RegExp.$2;
      for (const sep of [' ', '-']) {
        const variant = prefix + sep + num;
        const vIdx = lowerText.indexOf(variant);
        if (vIdx !== -1) {
          addMatch(callsign, icao, 0.9, getPosition(vIdx, variant.length));
        }
      }
    }
  }

  // Method 3: Standalone flight numbers
  const numPattern = /\b(\d{3,4})\b/g;
  let numMatch;
  while ((numMatch = numPattern.exec(lowerText)) !== null) {
    const num = numMatch[1];
    for (const [callsign, icao] of Object.entries(knownCallsigns)) {
      if (callsign.endsWith(num) && callsign.length <= num.length + 3) {
        addMatch(callsign, icao, 0.6, getPosition(numMatch.index, num.length));
      }
    }
  }

  // Method 4: Registration match
  if (aircraftState) {
    for (const [icao, state] of Object.entries(aircraftState)) {
      if (state.registration) {
        const reg = state.registration.toLowerCase();
        const idx = lowerText.indexOf(reg);
        if (idx !== -1) {
          addMatch(state.callsign || state.registration, icao, 0.85, getPosition(idx, reg.length));
        }
        const noDash = reg.replace(/-/g, '');
        if (noDash !== reg) {
          const nIdx = lowerText.indexOf(noDash);
          if (nIdx !== -1) {
            addMatch(state.callsign || state.registration, icao, 0.8, getPosition(nIdx, noDash.length));
          }
        }
      }
    }
  }

  return matches;
}

function extractFlightNumber(text) {
  const words = text.split(/[\s,]+/).slice(0, 6);
  let digits = '';
  for (const word of words) {
    if (/^\d$/.test(word)) { digits += word; }
    else if (/^\d+$/.test(word) && word.length <= 4) { digits += word; break; }
    else if (NUM_WORDS[word]) { digits += NUM_WORDS[word]; }
    else if (!['and', 'heavy', 'super'].includes(word)) {
      if (digits.length > 0) break;
      if (digits.length === 0 && words.indexOf(word) > 1) break;
    }
    if (digits.length >= 4) break;
  }
  return digits.length >= 2 ? digits : null;
}

function extractFlightNumberFromEnd(words) {
  let digits = '';
  for (let i = words.length - 1; i >= Math.max(0, words.length - 4); i--) {
    const word = words[i].toLowerCase();
    if (/^\d+$/.test(word) && word.length <= 4) { digits = word + digits; }
    else if (NUM_WORDS[word]) { digits = NUM_WORDS[word] + digits; }
    else break;
  }
  return digits.length >= 2 ? digits : null;
}

/**
 * Post-process transcript to fix known misheard words
 */
function postProcessTranscript(text) {
  const replacements = [
    // El Al variants
    [/\bLAL\b/gi, 'El Al'],
    [/\bElab\b/gi, 'El Al'],
    [/\bL-?Alpha-?L\b/gi, 'El Al'],
    [/\bLR(\d)/gi, 'El Al $1'],
    [/\bEI (\d)/gi, 'El Al $1'],
    [/\bALARM\b/gi, 'El Al'],
    [/\bALR\b/gi, 'El Al'],
    [/\bQAL\b/gi, 'El Al'],
    [/\bAllison\b/gi, 'El Al'],
    [/\bLyon\b/gi, 'El Al'],
    [/\bCELOT\b/gi, 'El Al'],
    [/\bAl-?Fatiha\b/gi, 'El Al'],
    [/\bAl-?Azhar\b/gi, 'El Al'],
    // Hebrew
    [/\blater\b(?=[\s.,!?]|$)/gi, 'lehitraot'],
    [/\bgood tour\b/gi, 'Toda'],
    [/\bgood to her\b/gi, 'Toda'],
    [/\bSvalbard\b/gi, 'Shalom'],
    [/\bSvanswana\b/gi, 'Shalom'],
    [/\bSalman\b/gi, 'Shalom'],
    [/\bSallallahu Alaikum\b/gi, 'Shalom'],
    [/\bErav Tava\b/gi, 'Erev Tov'],
    // ATC terms / locations
    [/\bBreccia\b/gi, 'QNH'],
    [/\bdesmond\b/gi, 'decimal'],
    [/\bSuva\b/gi, 'SUVAS'],
    [/\bsuba\b/gi, 'SUVAS'],
    [/\bTsukuba\b/gi, 'SUVAS'],
    [/\bTadov\b/gi, 'NATBG'],
    [/\bVessel\b/gi, 'VETEK'],
    [/\bWETEC\b/gi, 'VETEK'],
    [/\bJainapoti\b/gi, 'approach'],
    [/\bApollo\b/gi, 'APLON'],
    [/\bChopin\b/gi, 'Japan'],
    [/\bJoplin\b/gi, 'Japan'],
    [/\bSaman\b/gi, 'Amman'],
    [/\bSam\b(?=\s+\d)/gi, 'Amman'],
    [/\bELYSA\b/gi, 'ILS'],
    [/\bKennedy\b/gi, 'QNH'],
    [/\bmonths? final\b/gi, 'miles final'],
    [/\bdirect support\b/gi, 'ILS approach'],
    [/\bBIU\b/gi, 'Blue Bird'],
    [/\bBlue Strength\b/gi, 'Blue Bird'],
    [/\balmost one alpha\b/gi, 'AMMOS 1 Alpha'],
    // Airlines
    [/\bNL ?4\b/gi, 'Israir'],
    [/\bIRIS\b/gi, 'Israir'],
    [/\bis ?rail?\b/gi, 'Israir'],
    [/\bIsrael Air\b/gi, 'Israir'],
    [/\bSGN\b/gi, 'Aegean'],
    [/\bAGN\b/gi, 'Aegean'],
    [/\bAgencia\b/gi, 'Aegean'],
    [/\bAgent\b/gi, 'Aegean'],
    [/\bJAPN\b/gi, 'Japan'],
    [/\b2L1E\b/gi, 'BALMA 1E'],
  ];

  for (const [pattern, replacement] of replacements) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

function getStatus() { return isReady ? 'ready' : 'idle'; }
function reset() { audioBuffer = []; lastTranscribeTime = 0; }

module.exports = { init, feedAudio, tick, getStatus, reset };
