// Turns text into natural-sounding speech (MP3) using Microsoft Edge's free
// online neural voices. Unofficial: if it fails, the app falls back to the
// phone's own voice automatically.
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

const VOICES = new Set([
  'en-US-AndrewMultilingualNeural',
  'en-US-AvaMultilingualNeural',
  'en-US-BrianMultilingualNeural',
  'en-US-EmmaMultilingualNeural',
  'en-US-GuyNeural',
  'en-GB-RyanNeural',
  'en-GB-SoniaNeural',
  'en-AU-WilliamNeural',
]);

function escapeXml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function synth(text, voice) {
  return new Promise(async (resolve, reject) => {
    const tts = new MsEdgeTTS();
    const timer = setTimeout(() => {
      try { tts.close(); } catch {}
      reject(new Error('timeout'));
    }, 25000);
    try {
      await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
      const { audioStream } = tts.toStream(escapeXml(text));
      const chunks = [];
      audioStream.on('data', (c) => chunks.push(c));
      audioStream.on('error', (err) => {
        clearTimeout(timer);
        try { tts.close(); } catch {}
        reject(err);
      });
      audioStream.on('end', () => {
        clearTimeout(timer);
        try { tts.close(); } catch {}
        resolve(Buffer.concat(chunks));
      });
    } catch (err) {
      clearTimeout(timer);
      try { tts.close(); } catch {}
      reject(err);
    }
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST' });
    return;
  }
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const text = String((body && body.text) || '').replace(/\s+/g, ' ').trim().slice(0, 2500);
  const voice = VOICES.has(body && body.voice) ? body.voice : 'en-US-AndrewMultilingualNeural';
  if (!text) {
    res.status(400).json({ error: 'No text' });
    return;
  }
  try {
    let audio = await synth(text, voice);
    if (audio.length < 500) audio = await synth(text, voice); // one retry
    if (audio.length < 500) throw new Error('empty_audio');
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'public, s-maxage=86400');
    res.status(200).send(audio);
  } catch (e) {
    res.status(502).json({ error: 'voice_unavailable' });
  }
};
