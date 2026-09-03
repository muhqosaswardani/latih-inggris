-- Skema Tabel Cloudflare D1 untuk LATIH. (latih-db)
-- Merefleksikan object store IndexedDB latihDB (versi 7)
-- File media (audioBlob/videoBlob) disimpan di Workers KV (latih-media),
-- tabel D1 hanya menyimpan referensi 'blob_key'.

CREATE TABLE IF NOT EXISTS ketik (
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
);
CREATE INDEX IF NOT EXISTS idx_ketik_ts ON ketik(ts);

CREATE TABLE IF NOT EXISTS voice (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  mimeType TEXT,
  blob_key TEXT,
  sentence TEXT,
  correctedSentence TEXT,
  wordTags TEXT,
  meaning TEXT,
  pron TEXT,
  translation TEXT,
  status TEXT,
  meta TEXT
);
CREATE INDEX IF NOT EXISTS idx_voice_ts ON voice(ts);

CREATE TABLE IF NOT EXISTS video (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  mimeType TEXT,
  blob_key TEXT,
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
);
CREATE INDEX IF NOT EXISTS idx_video_ts ON video(ts);

CREATE TABLE IF NOT EXISTS baca (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  kind TEXT,
  query TEXT,
  title TEXT,
  titleId TEXT,
  paragraphs TEXT
);
CREATE INDEX IF NOT EXISTS idx_baca_ts ON baca(ts);

CREATE TABLE IF NOT EXISTS kamus (
  word TEXT PRIMARY KEY,
  translation TEXT,
  ts INTEGER
);

CREATE TABLE IF NOT EXISTS kamus_exclude (
  word TEXT PRIMARY KEY,
  ts INTEGER
);
