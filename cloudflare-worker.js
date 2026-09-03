// =====================================================================
// LATIH. - Proxy Gemini, TTS, D1 Database, & Workers KV (Cloudflare Worker)
// -----------------------------------------------------------------------
// Tugas file ini:
// 1. Menyimpan API key Gemini di SERVER (bukan di browser) untuk proxy AI & TTS
// 2. Sinkronisasi data teks ke Cloudflare D1 (tabel ketik, voice, video, baca, kamus)
// 3. Penyimpanan file media (audio & video mentah) ke Cloudflare Workers KV
//
// Bindings yang wajib ada di env:
// - env.GEMINI_KEYS (Secret)
// - env.DB (D1 Database binding: latih-db)
// - env.KV_MEDIA (KV Namespace binding: latih-media)
// =====================================================================

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
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders())
  });
}

function safeJsonParse(str, fallback) {
  if (!str) return fallback;
  if (typeof str === 'object') return str;
  try {
    return JSON.parse(str);
  } catch (e) {
    return fallback;
  }
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

    const url = new URL(request.url);
    const path = url.pathname;

    // ===================================================================
    // 1. ENDPOINTS MANAJEMEN BLOB (Workers KV: env.KV_MEDIA)
    // /blob/:id -> PUT (upload), GET (unduh), DELETE (hapus)
    // ===================================================================
    const blobMatch = path.match(/^\/blob\/(.+)$/);
    if (blobMatch) {
      if (!env.KV_MEDIA) {
        return jsonResponse({ error: 'Binding KV_MEDIA belum terkonfigurasi di Worker.' }, 500);
      }
      const blobId = decodeURIComponent(blobMatch[1]);

      if (request.method === 'PUT') {
        try {
          const mime = request.headers.get('Content-Type') || 'application/octet-stream';
          const arrayBuffer = await request.arrayBuffer();
          if (!arrayBuffer || arrayBuffer.byteLength === 0) {
            return jsonResponse({ error: 'Body binary tidak boleh kosong.' }, 400);
          }
          await env.KV_MEDIA.put(blobId, arrayBuffer, { metadata: { mimeType: mime, size: arrayBuffer.byteLength, ts: Date.now() } });
          return jsonResponse({ ok: true, id: blobId, size: arrayBuffer.byteLength, mimeType: mime });
        } catch (e) {
          return jsonResponse({ error: 'Gagal menyimpan blob ke KV: ' + e.message }, 500);
        }
      }

      if (request.method === 'GET') {
        try {
          const res = await env.KV_MEDIA.getWithMetadata(blobId, 'arrayBuffer');
          if (!res || !res.value) {
            return jsonResponse({ error: 'Blob tidak ditemukan di KV.' }, 404);
          }
          const mime = (res.metadata && res.metadata.mimeType) || 'application/octet-stream';
          return new Response(res.value, {
            headers: Object.assign(
              {
                'Content-Type': mime,
                'Cache-Control': 'public, max-age=31536000, immutable'
              },
              corsHeaders()
            )
          });
        } catch (e) {
          return jsonResponse({ error: 'Gagal mengambil blob dari KV: ' + e.message }, 500);
        }
      }

      if (request.method === 'DELETE') {
        try {
          await env.KV_MEDIA.delete(blobId);
          return jsonResponse({ ok: true, id: blobId });
        } catch (e) {
          return jsonResponse({ error: 'Gagal menghapus blob dari KV: ' + e.message }, 500);
        }
      }

      return jsonResponse({ error: 'Method not allowed untuk endpoint /blob/:id.' }, 405);
    }

    // ===================================================================
    // 2. ENDPOINTS SINKRONISASI TEKS (D1 Database: env.DB)
    // /sync/push, /sync/pull, /sync/delete, /admin/migrate
    // ===================================================================
    const DDL_STATEMENTS = [
      `CREATE TABLE IF NOT EXISTS ketik (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        text TEXT,
        diffs TEXT,
        corrections TEXT,
        note TEXT,
        translation TEXT,
        correctedSentence TEXT,
        status TEXT,
        meta TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ketik_ts ON ketik(ts)`,
      `CREATE TABLE IF NOT EXISTS voice (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        blob_key TEXT,
        mimeType TEXT,
        sentence TEXT,
        correctedSentence TEXT,
        wordTags TEXT,
        meaning TEXT,
        pron TEXT,
        translation TEXT,
        status TEXT,
        meta TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_voice_ts ON voice(ts)`,
      `CREATE TABLE IF NOT EXISTS video (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        blob_key TEXT,
        mimeType TEXT,
        thumb TEXT,
        duration TEXT,
        topic TEXT,
        sentence TEXT,
        correctedSentence TEXT,
        wordTags TEXT,
        meaning TEXT,
        pron TEXT,
        translation TEXT,
        status TEXT,
        meta TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_video_ts ON video(ts)`,
      `CREATE TABLE IF NOT EXISTS baca (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        kind TEXT,
        query TEXT,
        title TEXT,
        titleId TEXT,
        paragraphs TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_baca_ts ON baca(ts)`,
      `CREATE TABLE IF NOT EXISTS kamus (
        word TEXT PRIMARY KEY,
        translation TEXT,
        ts INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_kamus_ts ON kamus(ts)`,
      `CREATE TABLE IF NOT EXISTS kamus_exclude (
        word TEXT PRIMARY KEY,
        ts INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_kamus_exclude_ts ON kamus_exclude(ts)`
    ];

    async function ensureSchema(db) {
      try {
        for (const stmt of DDL_STATEMENTS) {
          await db.prepare(stmt).run();
        }
      } catch (err) {
        console.error('ensureSchema error:', err.message);
      }
    }

    if (path === '/admin/migrate') {
      if (!env.DB) {
        return jsonResponse({ error: 'Binding DB (D1) belum terkonfigurasi di Worker.' }, 500);
      }
      try {
        const results = [];
        for (const stmt of DDL_STATEMENTS) {
          const res = await env.DB.prepare(stmt).run();
          results.push(res);
        }
        return jsonResponse({ ok: true, message: 'D1 schema migration berhasil dieksekusi ke database!', count: results.length });
      } catch (e) {
        return jsonResponse({ error: 'Gagal eksekusi migrasi D1: ' + e.message }, 500);
      }
    }

    if (path === '/sync/push') {
      if (request.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed, pakai POST untuk /sync/push.' }, 405);
      }
      if (!env.DB) {
        return jsonResponse({ error: 'Binding DB (D1) belum terkonfigurasi di Worker.' }, 500);
      }
      await ensureSchema(env.DB);

      let body;
      try {
        body = await request.json();
      } catch (e) {
        return jsonResponse({ error: 'Body request /sync/push harus JSON.' }, 400);
      }

      try {
        const statements = [];

        // Ketik
        const ketikArr = Array.isArray(body.ketik) ? body.ketik : [];
        for (const item of ketikArr) {
          if (!item || !item.id) continue;
          statements.push(
            env.DB.prepare(
              `INSERT OR REPLACE INTO ketik (id, ts, text, diffs, corrections, note, translation, correctedSentence, status, meta)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).bind(
              String(item.id),
              Number(item.ts) || Date.now(),
              String(item.text || ''),
              JSON.stringify(item.diffs || []),
              JSON.stringify(item.corrections || []),
              String(item.note || ''),
              String(item.translation || ''),
              String(item.correctedSentence || ''),
              String(item.status || 'ok'),
              String(item.meta || '')
            )
          );
        }

        // Voice (tanpa audioBlob mentah, hanya blob_key)
        const voiceArr = Array.isArray(body.voice) ? body.voice : [];
        for (const item of voiceArr) {
          if (!item || !item.id) continue;
          statements.push(
            env.DB.prepare(
              `INSERT OR REPLACE INTO voice (id, ts, mimeType, blob_key, sentence, correctedSentence, wordTags, meaning, pron, translation, status, meta)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).bind(
              String(item.id),
              Number(item.ts) || Date.now(),
              String(item.mimeType || 'audio/webm'),
              String(item.blob_key || item.id),
              String(item.sentence || ''),
              String(item.correctedSentence || ''),
              JSON.stringify(item.wordTags || []),
              JSON.stringify(item.meaning || []),
              JSON.stringify(item.pron || []),
              String(item.translation || ''),
              String(item.status || 'ok'),
              String(item.meta || '')
            )
          );
        }

        // Video (tanpa videoBlob mentah, hanya blob_key)
        const videoArr = Array.isArray(body.video) ? body.video : [];
        for (const item of videoArr) {
          if (!item || !item.id) continue;
          statements.push(
            env.DB.prepare(
              `INSERT OR REPLACE INTO video (id, ts, mimeType, blob_key, thumb, duration, topic, sentence, correctedSentence, wordTags, meaning, pron, translation, status, meta)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).bind(
              String(item.id),
              Number(item.ts) || Date.now(),
              String(item.mimeType || 'video/webm'),
              String(item.blob_key || item.id),
              String(item.thumb || ''),
              String(item.duration || ''),
              String(item.topic || ''),
              String(item.sentence || ''),
              String(item.correctedSentence || ''),
              JSON.stringify(item.wordTags || []),
              JSON.stringify(item.meaning || []),
              JSON.stringify(item.pron || []),
              String(item.translation || ''),
              String(item.status || 'ok'),
              String(item.meta || '')
            )
          );
        }

        // Baca
        const bacaArr = Array.isArray(body.baca) ? body.baca : [];
        for (const item of bacaArr) {
          if (!item || !item.id) continue;
          statements.push(
            env.DB.prepare(
              `INSERT OR REPLACE INTO baca (id, ts, kind, query, title, titleId, paragraphs)
               VALUES (?, ?, ?, ?, ?, ?, ?)`
            ).bind(
              String(item.id),
              Number(item.ts) || Date.now(),
              String(item.kind || 'news'),
              String(item.query || ''),
              String(item.title || ''),
              String(item.titleId || ''),
              JSON.stringify(item.paragraphs || [])
            )
          );
        }

        // Kamus
        const kamusArr = Array.isArray(body.kamus) ? body.kamus : [];
        for (const item of kamusArr) {
          if (!item || !item.word) continue;
          statements.push(
            env.DB.prepare(
              `INSERT OR REPLACE INTO kamus (word, translation, ts)
               VALUES (?, ?, ?)`
            ).bind(
              String(item.word).toLowerCase().trim(),
              String(item.translation || ''),
              Number(item.ts) || Date.now()
            )
          );
        }

        // Kamus Exclude
        const kamusExArr = Array.isArray(body.kamusExclude) ? body.kamusExclude : [];
        for (const item of kamusExArr) {
          if (!item || !item.word) continue;
          statements.push(
            env.DB.prepare(
              `INSERT OR REPLACE INTO kamus_exclude (word, ts)
               VALUES (?, ?)`
            ).bind(
              String(item.word).toLowerCase().trim(),
              Number(item.ts) || Date.now()
            )
          );
        }

        // D1 membatasi batch size (~100 statements per call), kita chunk jika perlu
        const CHUNK_SIZE = 90;
        let executed = 0;
        for (let i = 0; i < statements.length; i += CHUNK_SIZE) {
          const chunk = statements.slice(i, i + CHUNK_SIZE);
          await env.DB.batch(chunk);
          executed += chunk.length;
        }

        return jsonResponse({ ok: true, savedStatements: executed });
      } catch (e) {
        return jsonResponse({ error: 'Gagal push ke D1: ' + e.message }, 500);
      }
    }

    if (path === '/sync/pull') {
      if (request.method !== 'GET') {
        return jsonResponse({ error: 'Method not allowed, pakai GET untuk /sync/pull.' }, 405);
      }
      if (!env.DB) {
        return jsonResponse({ error: 'Binding DB (D1) belum terkonfigurasi di Worker.' }, 500);
      }
      await ensureSchema(env.DB);

      try {
        const [kRes, vRes, vdRes, bRes, kmRes, kxRes] = await env.DB.batch([
          env.DB.prepare('SELECT * FROM ketik ORDER BY ts DESC'),
          env.DB.prepare('SELECT * FROM voice ORDER BY ts DESC'),
          env.DB.prepare('SELECT * FROM video ORDER BY ts DESC'),
          env.DB.prepare('SELECT * FROM baca ORDER BY ts DESC'),
          env.DB.prepare('SELECT * FROM kamus ORDER BY word ASC'),
          env.DB.prepare('SELECT * FROM kamus_exclude ORDER BY word ASC')
        ]);

        const ketik = (kRes.results || []).map(r => ({
          ...r,
          diffs: safeJsonParse(r.diffs, []),
          corrections: safeJsonParse(r.corrections, [])
        }));

        const voice = (vRes.results || []).map(r => ({
          ...r,
          wordTags: safeJsonParse(r.wordTags, []),
          meaning: safeJsonParse(r.meaning, []),
          pron: safeJsonParse(r.pron, [])
        }));

        const video = (vdRes.results || []).map(r => ({
          ...r,
          wordTags: safeJsonParse(r.wordTags, []),
          meaning: safeJsonParse(r.meaning, []),
          pron: safeJsonParse(r.pron, [])
        }));

        const baca = (bRes.results || []).map(r => ({
          ...r,
          paragraphs: safeJsonParse(r.paragraphs, [])
        }));

        return jsonResponse({
          ok: true,
          ketik,
          voice,
          video,
          baca,
          kamus: kmRes.results || [],
          kamusExclude: kxRes.results || []
        });
      } catch (e) {
        return jsonResponse({ error: 'Gagal pull dari D1: ' + e.message }, 500);
      }
    }

    if (path === '/sync/delete') {
      if (request.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed, pakai POST untuk /sync/delete.' }, 405);
      }
      if (!env.DB) {
        return jsonResponse({ error: 'Binding DB (D1) belum terkonfigurasi di Worker.' }, 500);
      }
      await ensureSchema(env.DB);

      let body;
      try {
        body = await request.json();
      } catch (e) {
        return jsonResponse({ error: 'Body request /sync/delete harus JSON.' }, 400);
      }

      const scope = body.scope;
      const ids = Array.isArray(body.ids) ? body.ids : (body.id ? [body.id] : []);
      if (!scope || !ids.length) {
        return jsonResponse({ error: 'Field "scope" dan array "ids" wajib diisi.' }, 400);
      }

      const tableMap = {
        ketik: { table: 'ketik', key: 'id' },
        voice: { table: 'voice', key: 'id' },
        video: { table: 'video', key: 'id' },
        baca: { table: 'baca', key: 'id' },
        kamus: { table: 'kamus', key: 'word' },
        kamusExclude: { table: 'kamus_exclude', key: 'word' }
      };

      const info = tableMap[scope];
      if (!info) {
        return jsonResponse({ error: 'Scope tidak valid: ' + scope }, 400);
      }

      try {
        // Jika voice atau video, hapus juga file medianya dari KV agar tidak ada blob yatim
        if ((scope === 'voice' || scope === 'video') && env.KV_MEDIA) {
          for (const id of ids) {
            try {
              await env.KV_MEDIA.delete(id);
            } catch (kvErr) {
              // Teruskan penghapusan tabel meski satu blob gagal
            }
          }
        }

        const statements = ids.map(id =>
          env.DB.prepare(`DELETE FROM ${info.table} WHERE ${info.key} = ?`).bind(id)
        );

        const CHUNK_SIZE = 90;
        let deletedCount = 0;
        for (let i = 0; i < statements.length; i += CHUNK_SIZE) {
          const chunk = statements.slice(i, i + CHUNK_SIZE);
          await env.DB.batch(chunk);
          deletedCount += chunk.length;
        }

        return jsonResponse({ ok: true, deleted: deletedCount, scope });
      } catch (e) {
        return jsonResponse({ error: 'Gagal menghapus data di D1/KV: ' + e.message }, 500);
      }
    }

    if (path === '/sync/storage') {
      if (request.method !== 'GET') {
        return jsonResponse({ error: 'Method not allowed, gunakan GET untuk /sync/storage.' }, 405);
      }
      try {
        let kvCount = 0;
        let kvBytes = 0;
        if (env.KV_MEDIA) {
          const list = await env.KV_MEDIA.list({ limit: 1000 });
          kvCount = (list.keys || []).length;
          for (const k of (list.keys || [])) {
            if (k.metadata && k.metadata.size) {
              kvBytes += Number(k.metadata.size);
            }
          }
        }
        let d1Counts = { ketik: 0, voice: 0, video: 0, baca: 0, kamus: 0 };
        if (env.DB) {
          try {
            const [kRes, vRes, vdRes, bRes, kmRes] = await env.DB.batch([
              env.DB.prepare('SELECT count(*) as total FROM ketik'),
              env.DB.prepare('SELECT count(*) as total FROM voice'),
              env.DB.prepare('SELECT count(*) as total FROM video'),
              env.DB.prepare('SELECT count(*) as total FROM baca'),
              env.DB.prepare('SELECT count(*) as total FROM kamus')
            ]);
            d1Counts.ketik = (kRes.results && kRes.results[0] && kRes.results[0].total) || 0;
            d1Counts.voice = (vRes.results && vRes.results[0] && vRes.results[0].total) || 0;
            d1Counts.video = (vdRes.results && vdRes.results[0] && vdRes.results[0].total) || 0;
            d1Counts.baca = (bRes.results && bRes.results[0] && bRes.results[0].total) || 0;
            d1Counts.kamus = (kmRes.results && kmRes.results[0] && kmRes.results[0].total) || 0;
          } catch (e) {}
        }
        return jsonResponse({
          ok: true,
          kv: {
            count: kvCount,
            bytes: kvBytes,
            limitBytes: 1073741824 // 1 GB (1024 MB) free tier
          },
          d1: {
            counts: d1Counts,
            limitBytes: 5368709120 // 5 GB free tier
          }
        });
      } catch (e) {
        return jsonResponse({ error: 'Gagal mengambil info storage: ' + e.message }, 500);
      }
    }

    // ===================================================================
    // 3. PROXY GEMINI & TTS (ROOT / POST /)
    // Tetap dipertahankan apa adanya untuk komunikasi AI & suara
    // ===================================================================
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
