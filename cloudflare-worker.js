// =====================================================================
// LATIH. - Proxy Gemini (Cloudflare Worker)
// -----------------------------------------------------------------------
// Tugas file ini: nyimpen API key Gemini di SERVER (bukan di browser),
// jadi PWA/HTML kamu bisa dipublikasikan di GitHub Pages tanpa bocorin
// key. PWA cuma manggil URL Worker ini, Worker yang manggil Gemini
// pakai key asli yang cuma dia tahu.
//
// Cara pasang: lihat README_SETUP.md. Ringkasnya - paste file ini ke
// Cloudflare Workers (dashboard, "Quick Edit"), lalu set secret
// GEMINI_KEYS lewat Settings > Variables (BUKAN ditulis di sini).
// =====================================================================

// Kalau nanti udah tau URL PWA kamu (mis. https://username.github.io),
// ganti '*' di bawah dengan URL itu biar cuma PWA kamu yang boleh manggil
// Worker ini. Boleh dibiarkan '*' dulu selagi masih coba-coba.
const ALLOWED_ORIGIN = '*';

const GEMINI_MODELS = [
  'gemini-2.0-flash', 'gemini-2.0-flash-lite',
  'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro',
  'gemini-3-flash', 'gemini-3.1-pro', 'gemini-3.1-flash-lite',
  'gemini-3.5-flash', 'gemini-3.5-flash-lite',
  'gemini-3.6-flash', 'gemini-3.7-flash'
];

// Model TTS Gemini - gratis di free tier (Aug 2026), suara jauh lebih natural
// dibanding Web Speech API browser. Dicoba berurutan, fallback ke model lain
// kalau salah satu limit/gagal.
const GEMINI_TTS_MODELS = ['gemini-2.5-flash-preview-tts', 'gemini-3.1-flash-tts-preview'];

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders())
  });
}

// Panggil Gemini TTS: mengembalikan audio PCM base64 + mimeType (mengandung
// sample rate, mis. "audio/L16;codec=pcm;rate=24000"). Konversi ke WAV
// dilakukan di sisi klien (index.html) supaya Worker tetap ringan.
async function handleTts(text, keys) {
  const errors = [];
  let keyPtr = 0;
  for (let m = 0; m < GEMINI_TTS_MODELS.length; m++) {
    const model = GEMINI_TTS_MODELS[m];
    for (let k = 0; k < keys.length; k++) {
      const key = keys[keyPtr % keys.length];
      keyPtr++;
      const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model +
        ':generateContent?key=' + encodeURIComponent(key);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: 'Say clearly, naturally, at a normal pace, like a friendly English tutor demonstrating correct pronunciation: ' + text }] }],
            generationConfig: {
              responseModalities: ['AUDIO'],
              speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } }
            }
          })
        });

        if (res.status === 404 || res.status === 400) {
          errors.push(model + ': HTTP ' + res.status + ' (model tidak tersedia)');
          break; // coba model TTS lain
        }
        if (res.status === 429 || res.status === 403) {
          errors.push(model + ' key#' + (k + 1) + ': HTTP ' + res.status + ' (limit/izin)');
          continue; // rotasi ke key berikutnya
        }
        if (!res.ok) {
          errors.push(model + ': HTTP ' + res.status);
          continue;
        }

        const data = await res.json();
        const cand = data.candidates && data.candidates[0];
        const part = cand && cand.content && cand.content.parts && cand.content.parts[0];
        const inline = part && part.inlineData;
        if (!inline || !inline.data) {
          errors.push(model + ': audio kosong');
          continue;
        }
        return { audioData: inline.data, mimeType: inline.mimeType || 'audio/L16;rate=24000' };
      } catch (e) {
        errors.push(model + ': ' + e.message);
      }
    }
  }
  return { error: 'Semua model TTS & API key gagal dicoba. Detail terakhir: ' + errors.slice(-6).join('; ') };
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }
    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed, pakai POST.' }, 405);
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return jsonResponse({ error: 'Body request harus JSON.' }, 400);
    }

    // GEMINI_KEYS diset sebagai secret di dashboard Cloudflare,
    // formatnya: key1,key2,key3 (dipisah koma, tanpa spasi ekstra)
    const rawKeys = (env.GEMINI_KEYS || '');
    const keys = rawKeys.split(',').map(function (k) { return k.trim(); }).filter(Boolean);
    if (!keys.length) {
      return jsonResponse({ error: 'Server belum diset GEMINI_KEYS. Cek Settings > Variables di Cloudflare.' }, 500);
    }

    // Mode TTS (dengar pengucapan) - jalur terpisah dari mode analisis JSON di bawah
    if (body && body.mode === 'tts') {
      const text = body.text;
      if (!text) {
        return jsonResponse({ error: 'Field "text" wajib diisi untuk mode tts.' }, 400);
      }
      const result = await handleTts(text, keys);
      if (result.error) {
        return jsonResponse(result, 502);
      }
      return jsonResponse(result);
    }

    const parts = body && body.parts;
    const schema = body && body.schema;
    if (!parts) {
      return jsonResponse({ error: 'Field "parts" wajib diisi.' }, 400);
    }

    const errors = [];
    let keyPtr = 0;

    for (let m = 0; m < GEMINI_MODELS.length; m++) {
      const model = GEMINI_MODELS[m];
      for (let k = 0; k < keys.length; k++) {
        const key = keys[keyPtr % keys.length];
        keyPtr++;
        const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model +
          ':generateContent?key=' + encodeURIComponent(key);
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ role: 'user', parts: parts }],
              generationConfig: { responseMimeType: 'application/json', responseSchema: schema, temperature: 0.4 }
            })
          });

          if (res.status === 404 || res.status === 400) {
            errors.push(model + ': HTTP ' + res.status + ' (model tidak tersedia)');
            break; // coba model lain
          }
          if (res.status === 429 || res.status === 403) {
            errors.push(model + ' key#' + (k + 1) + ': HTTP ' + res.status + ' (limit/izin)');
            continue; // rotasi ke key berikutnya
          }
          if (!res.ok) {
            errors.push(model + ': HTTP ' + res.status);
            continue;
          }

          const data = await res.json();
          const cand = data.candidates && data.candidates[0];
          const text = cand && cand.content && cand.content.parts &&
            cand.content.parts[0] && cand.content.parts[0].text;
          if (!text) {
            errors.push(model + ': respons kosong');
            continue;
          }

          // langsung forward teks JSON dari Gemini apa adanya ke klien
          return new Response(text, {
            headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders())
          });
        } catch (e) {
          errors.push(model + ': ' + e.message);
        }
      }
    }

    return jsonResponse({
      error: 'Semua model & API key gagal dicoba. Detail terakhir: ' + errors.slice(-6).join('; ')
    }, 502);
  }
};
