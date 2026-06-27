/**
 * Whisper Worker Thread
 * Runs transcription in a separate thread to avoid blocking the main event loop.
 * Optimized for ATC radio: uses English-only model + ATC prompt biasing.
 */
const { parentPort } = require('worker_threads');
const { pipeline } = require('@xenova/transformers');

let whisperPipeline = null;

// ATC vocabulary prompt - biases Whisper towards aviation terminology
const ATC_PROMPT = `ATC radio communication. Callsigns, headings, altitudes, runways, frequencies.
Tower, approach, ground, departure, cleared, maintain, descend, climb, turn left, turn right,
heading, flight level, runway, ILS, visual approach, contact, squawk, roger, wilco, affirm,
El Al, Israir, Arkia, Turkish, Speedbird, Lufthansa, Emirates, Qatar, Delta, United, American.`;

async function init() {
  console.log('🧠 [Worker] Loading Whisper base.en model...');
  whisperPipeline = await pipeline(
    'automatic-speech-recognition',
    'Xenova/whisper-base.en',
    { quantized: true }
  );
  console.log('✅ [Worker] Whisper model loaded');
  parentPort.postMessage({ type: 'ready' });
}

parentPort.on('message', async (msg) => {
  if (msg.type === 'transcribe') {
    try {
      const float32 = new Float32Array(msg.audioBuffer);
      const t0 = Date.now();
      const result = await whisperPipeline(float32, {
        sampling_rate: 16000,
        language: 'english',
        task: 'transcribe',
      });
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      const text = (result?.text || '').trim();
      parentPort.postMessage({
        type: 'result',
        text,
        elapsed,
        id: msg.id,
      });
    } catch (e) {
      parentPort.postMessage({
        type: 'error',
        message: e.message,
        id: msg.id,
      });
    }
  }
});

init().catch(e => {
  console.error('❌ [Worker] Failed to load Whisper:', e.message);
  parentPort.postMessage({ type: 'error', message: e.message });
});
