# Rencana Migrasi Cloud — LATIH. (latih-inggris)

Status: **Sudah dieksekusi ke kode (versi v1.5.0, 3 September 2026).**
Dibuat: 1 September 2026. Direvisi & Dieksekusi: 3 September 2026 (Workers KV + Cloudflare D1).

---

## 1. Latar belakang & masalah

App LATIH. saat ini 100% lokal: semua data (riwayat Ketik, Voice, Video, Baca,
Kamus, streak/aktivitas harian) disimpan di **IndexedDB** milik browser
(`DB_NAME = 'latihDB'`), termasuk **blob audio/video mentah** di setiap entri
Voice & Video. Satu-satunya cara pindah data antar device sekarang adalah
export/import manual (unduh 1 file `.json` berisi semua entri, termasuk blob
sebagai base64).

Risiko: sama seperti yang terjadi di app Tunas — data bisa hilang kalau
browser/HP membersihkan storage, app di-uninstall, atau pindah device —
karena semuanya cuma ada di satu tempat (lokal).

Tujuan migrasi: data **otomatis sync ke cloud**, termasuk blob audio/video,
tanpa mengorbankan kualitas biaya (tetap gratis), tanpa perlu sistem
login/akun rumit (dipakai sendiri), **dan tanpa perlu daftar/verifikasi kartu
baru sama sekali** (syarat eksplisit dari pengguna).

## 2. Struktur data saat ini (IndexedDB, `latihDB`, versi 7)

| Object store | Isi | Ada blob? |
|---|---|---|
| `ketik` | Entri latihan menulis (kalimat, koreksi, meaning, dll) | Tidak |
| `voice` | Entri latihan bicara: transkrip, koreksi, wordTags, pron, **+ `audioBlob`** | **Ya** |
| `video` | Entri latihan video (maks durasi 1:30 menit), serupa `voice` **+ blob video** | **Ya** |
| `baca` | Entri latihan membaca (artikel/cerita AI) | Tidak |
| `meta` | Metadata bantu (mis. cache ide topik) | Tidak |
| `kamus` | Kosakata yang dikumpulkan otomatis dari sesi latihan | Tidak |
| `kamusExclude` | Kata yang di-exclude dari daftar kamus (nama diri, dll) | Tidak |
| `rekapCache` | Cache hasil rekap yang sudah pernah digenerate | Tidak |
| `ttsCache` | Cache audio hasil Gemini TTS (audio "Dengar") | **Ya (cache, bisa di-generate ulang, tidak perlu ikut sync)** |

Streak & kalender aktivitas dihitung dari tanggal (`ts`) entri-entri di atas,
bukan tabel terpisah.

## 3. Kenapa Cloudflare Workers KV + D1 ("Plan B"), bukan R2 / Firebase / Google Drive

Perjalanan keputusan (biar chat baru paham konteksnya, bukan cuma hasil akhir):

- **Firebase Storage** (buat nyimpen file) sudah **tidak gratis lagi** sejak
  Februari 2026 — Spark plan (gratis) kehilangan akses Cloud Storage, wajib
  upgrade ke paket berbayar (Blaze). Firestore sendiri (data teks) masih
  gratis tapi tidak cocok untuk file besar (batas 1 MiB/dokumen).
- **Google Drive** butuh setup baru dari nol (project di Google Cloud
  Console, OAuth Consent Screen, OAuth Client ID) dan token API-nya
  kadaluarsa tiap ~1 jam — lebih ribet dibanding "tidak daftar apa-apa lagi"
  yang diminta pengguna, walau tidak butuh kartu.
- **Cloudflare R2** (rencana awal/"Plan A") — gratis 10 GB, tapi **wajib
  aktivasi R2 subscription yang minta verifikasi kartu debit/kredit**
  terlebih dulu (walau $0 ditagih selama di bawah kuota). Pengguna tidak
  punya kartu kredit dan tidak mau proses pendaftaran/verifikasi tambahan →
  **R2 dibatalkan**.
- **Cloudflare Workers KV** (dipakai sekarang, "Plan B") — bagian dari
  Workers Free plan yang **sudah otomatis aktif** di akun yang sama dengan
  Worker `latih-proxy` yang sudah jalan. **Tidak perlu kartu, tidak perlu
  aktivasi/subscription apa pun.**
- **Cloudflare D1** juga bagian dari Workers Free plan yang sama — tidak
  perlu kartu.

Konsekuensi trade-off memilih KV dibanding R2: kapasitas jauh lebih kecil (1
GB vs 10 GB) — lihat bagian 6.

## 4. Arsitektur baru yang direncanakan

```
index.html (browser)
   |
   |-- (sudah ada) POST /generate --> Worker latih-proxy --> Gemini API
   |
   |-- (BARU) POST /sync/push, GET /sync/pull  --> Worker latih-proxy --> D1 (metadata teks)
   |-- (BARU) PUT /blob/:id, GET /blob/:id      --> Worker latih-proxy --> Workers KV (file audio/video)
```

- **Cloudflare D1** (database SQL, gratis s.d. 5 GB storage, 5 juta baca /
  100 ribu tulis per hari, tanpa kartu): menyimpan semua data teks — entri
  `ketik`, `voice` (tanpa blob), `video` (tanpa blob), `baca`, `kamus`,
  `kamusExclude`. Setiap entri Voice/Video menyimpan **referensi** ke file
  blobnya di KV (bukan blobnya langsung), mis. kolom `blob_key`.
- **Cloudflare Workers KV** (key-value storage, gratis 1 GB total, maks 25 MB
  per value, 1.000 tulis/hari, 100.000 baca/hari, tanpa kartu): menyimpan
  file audio & video mentah, dikunci per `entry_id`. Video maks 1:30 menit
  (~5-8 MB) masih di bawah batas 25 MB per value.
- **Worker `latih-proxy` yang sudah ada** ditambah beberapa endpoint baru
  (bukan bikin server baru) untuk push/pull data teks ke D1 dan upload/ambil
  blob ke/dari KV.
- `ttsCache` (cache audio "Dengar") **tidak ikut disinkron** — sifatnya cuma
  cache lokal yang bisa digenerate ulang kapan saja dari Gemini TTS, tidak
  ada nilai riwayat yang hilang kalau tidak disync.
- Strategi merge saat pull dari cloud: sama seperti Tunas — gabung
  berdasarkan `id`, bukan timpa total, supaya data dari 2 device tidak saling
  hilang.
- **Kalau kuota harian KV/D1 kepenuhan** (jarang terjadi untuk pemakaian
  pribadi): operasi sync hari itu gagal dengan error, reset otomatis besok
  00:00 UTC. **Tidak ada risiko tagihan** karena tidak ada kartu terdaftar
  di akun — paling buruk cuma "sync tertunda", bukan biaya.

## 5. Fitur baru yang diminta (di luar sync otomatis)

Diminta berlaku **untuk semua jenis riwayat** (Ketik, Voice, Video, Baca),
bukan cuma Video:

1. **Download murni file** — bukan cuma export JSON gabungan seperti
   sekarang. Untuk Voice/Video: unduh file audio/video aslinya (mis. `.webm`
   atau `.mp4`) langsung per entri atau per kumpulan.
2. **Pilih rentang tanggal** sebelum download — bukan cuma "unduh semua",
   user bisa pilih dari tanggal berapa sampai tanggal berapa yang mau
   diunduh.
3. **Hapus riwayat berbasis rentang tanggal** — saat ini cuma bisa hapus 1
   entri sekaligus (tombol "Hapus riwayat ini"), belum ada opsi masal. Nanti
   ditambah opsi pilih rentang tanggal, lalu hapus semua entri dalam rentang
   itu sekaligus (di local IndexedDB **dan** di cloud KV/D1 sekaligus, biar
   konsisten).

Fitur nomor 3 ini juga jadi cara utama menjaga kapasitas KV (1 GB) tidak
cepat penuh — lihat bagian 6.

## 6. Estimasi kapasitas & daya tahan (asumsi kualitas standar, bukan HD)

| Jenis | Estimasi ukuran per entri |
|---|---|
| Audio (± 10-20 detik) | ~100-250 KB |
| Video (maks durasi 1:30 menit, ±480p, bitrate rendah-menengah) | ~5-8 MB |

Dengan kuota **Workers KV 1 GB total** (bukan 10 GB seperti R2):

| Skenario | Kira-kira muat |
|---|---|
| Cuma video | ± 130-200 video |
| Cuma audio | ± 4.000-10.000 rekaman |
| Campuran (5 video + 5 audio/hari) | ± 28 hari (~1 bulan) sebelum penuh |

Karena kapasitasnya jauh lebih kecil dibanding rencana R2 sebelumnya (10 GB),
**fitur hapus riwayat rentang tanggal (bagian 5, poin 3) jadi wajib dipakai
rutin**, bukan sekadar nice-to-have. Data teks (transkrip, skor, koreksi) di
D1 tidak ikut kena masalah ini karena kuotanya jauh lebih longgar (5 GB) dan
tidak menyimpan blob.

## 7. 🙋 Langkah MANUAL (harus dilakukan pengguna sendiri, tidak bisa didelegasikan)

AI (Claude/Antigravity) **tidak punya akses** ke dashboard Cloudflare
pengguna — bagian ini wajib dikerjakan sendiri di browser, dipandu
step-by-step lewat screenshot. **Tidak ada langkah yang minta kartu atau
verifikasi pembayaran** di Plan B ini:

1. Buat **KV namespace** baru (mis. nama `latih-media`), di dashboard
   Cloudflare > Storage & databases > KV.
2. Buat **D1 database** baru (mis. nama `latih-db`), di dashboard Cloudflare
   > Storage & databases > D1 SQLite Database.
3. Bind KV namespace dan D1 database ke Worker `latih-proxy` yang sudah ada
   (lewat halaman Worker > Settings > Bindings).

Setelah 3 langkah ini selesai, sisanya (section 8 di bawah) **sepenuhnya**
dikerjakan AI lewat akses repo GitHub — tidak perlu pengguna sentuh kode
sama sekali.

## 8. 🤖 Langkah OTOMATIS (dieksekusi AI/Antigravity lewat akses repo GitHub, belum dilakukan)

Semua poin di bawah ini dikerjakan lewat `git clone` + edit file + commit +
push ke repo `latih-inggris` (butuh token GitHub & fitur code
execution aktif di chat — lihat catatan di bagian atas konteks project).
Pengguna tinggal cek hasilnya, tidak perlu menulis kode sendiri:

1. Definisikan skema tabel D1 (satu tabel per jenis: `ketik`, `voice`,
   `video`, `baca`, `kamus`, `kamus_exclude`).
2. Tambah endpoint baru di `cloudflare-worker.js`: `/sync/push`,
   `/sync/pull`, `/blob/:id` (PUT untuk upload, GET untuk ambil dari KV).
3. Di `index.html`: setiap `idbPut(...)` yang sudah ada juga memicu push ke
   cloud (mirip pola `scheduleCloudPush()` di app Tunas), dan saat app dibuka
   akan pull + merge dari cloud sebelum render.
4. Tambah UI baru: pemilih rentang tanggal untuk fitur download murni
   audio/video dan fitur hapus riwayat massal (bagian 5), diterapkan ke ke-4
   jenis riwayat (Ketik, Voice, Video, Baca).
5. Naikkan `APP_VERSION` (sekarang `v1.4.4`) dan `DB_VERSION` IndexedDB kalau
   ada perubahan skema store lokal.
6. Commit & push ke repo `latih-inggris`.

**Catatan untuk chat baru:** kalau ada 1 saja langkah di section 7 yang
belum kamu lakukan, bilang ke AI supaya dipandu dulu step-by-step sebelum
lanjut ke section 8 — soalnya binding KV/D1 harus ada dulu sebelum kode di
Worker bisa dites jalan.
