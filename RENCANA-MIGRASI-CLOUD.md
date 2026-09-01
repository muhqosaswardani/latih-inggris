# Rencana Migrasi Cloud — LATIH. (latih-inggris)

Status: **Rencana, belum dieksekusi ke kode.**
Dibuat: 1 September 2026.

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
tanpa mengorbankan kualitas biaya (tetap gratis) dan tanpa perlu sistem
login/akun rumit (dipakai sendiri).

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

## 3. Kenapa Cloudflare, bukan Firebase / Google Drive

- **Firebase Storage** (buat nyimpen file) sudah **tidak gratis lagi** sejak
  Februari 2026 — Spark plan (gratis) kehilangan akses Cloud Storage, wajib
  upgrade ke paket berbayar (Blaze) untuk pakai fitur ini. Firestore sendiri
  (buat data teks) masih gratis, tapi nggak cocok buat nyimpen file
  audio/video besar (batas 1 MiB per dokumen, base64 bikin ukuran membengkak
  ±33%).
- **Google Drive** butuh login OAuth per pengguna dan didesain buat file
  pribadi manual, bukan backend otomatis untuk aplikasi — rawan token
  kadaluarsa dan ribet diotomatisasi tanpa munculin popup login berulang.
- **Cloudflare** sudah dipakai app ini lewat Worker `latih-proxy` (proxy ke
  Gemini API, key disimpan aman di server). Menambah R2 + D1 di platform yang
  sama artinya tidak perlu kelola 2 cloud terpisah, dan credential tetap
  disimpan aman di server (bukan di file HTML).

## 4. Arsitektur baru yang direncanakan

```
index.html (browser)
   |
   |-- (sudah ada) POST /generate --> Worker latih-proxy --> Gemini API
   |
   |-- (BARU) POST /sync/push, GET /sync/pull  --> Worker latih-proxy --> D1 (metadata teks)
   |-- (BARU) PUT /blob/:id, GET /blob/:id      --> Worker latih-proxy --> R2 (file audio/video)
```

- **Cloudflare D1** (database SQL, gratis s.d. 5 GB): menyimpan semua data
  teks — entri `ketik`, `voice` (tanpa blob), `video` (tanpa blob), `baca`,
  `kamus`, `kamusExclude`. Setiap entri Voice/Video menyimpan **referensi**
  ke file blobnya di R2 (bukan blobnya langsung), mis. kolom `blob_key`.
- **Cloudflare R2** (object storage, gratis 10 GB, **nol biaya
  download/egress**): menyimpan file audio & video mentah, dikunci per
  `entry_id`.
- **Worker `latih-proxy` yang sudah ada** ditambah beberapa endpoint baru
  (bukan bikin server baru) untuk push/pull data teks ke D1 dan upload/ambil
  blob ke/dari R2.
- `ttsCache` (cache audio "Dengar") **tidak ikut disinkron** — sifatnya cuma
  cache lokal yang bisa digenerate ulang kapan saja dari Gemini TTS, tidak
  ada nilai riwayat yang hilang kalau tidak disync.
- Strategi merge saat pull dari cloud: sama seperti Tunas — gabung
  berdasarkan `id`, bukan timpa total, supaya data dari 2 device tidak saling
  hilang.

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
   entri sekaligus (tombol "Hapus riwayat ini") atau tidak ada opsi "hapus
   semua" masal. Nanti ditambah opsi pilih rentang tanggal, lalu hapus semua
   entri dalam rentang itu sekaligus (di local IndexedDB **dan** di cloud
   R2/D1 sekaligus, biar konsisten).

## 6. Estimasi kapasitas & daya tahan (asumsi kualitas standar, bukan HD)

| Jenis | Estimasi ukuran per entri |
|---|---|
| Audio (± 10-20 detik) | ~100-250 KB |
| Video (maks durasi 1:30 menit, ±480p, bitrate rendah-menengah) | ~5-8 MB |

Skenario pemakaian ±5 sesi video + 5 sesi audio/hari ≈ 36 MB/hari ≈ ~1
GB/bulan. Dari kuota gratis R2 10 GB → tahan **±9-10 bulan** kalau riwayat
lama tidak pernah dihapus, dan jauh lebih awet lagi begitu fitur hapus
riwayat rentang tanggal (poin 5) mulai dipakai rutin.

## 7. 🙋 Langkah MANUAL (harus dilakukan pengguna sendiri, tidak bisa didelegasikan)

AI (Claude/Antigravity) **tidak punya akses** ke dashboard Cloudflare
pengguna — bagian ini wajib dikerjakan sendiri di browser, dipandu
step-by-step lewat screenshot (pola yang sama seperti setup Firebase untuk
app Tunas):

1. Buat **R2 bucket** baru (mis. nama `latih-media`), di dashboard Cloudflare
   > R2.
2. Buat **D1 database** baru (mis. nama `latih-db`), di dashboard Cloudflare
   > Workers & Pages > D1.
3. Bind R2 bucket dan D1 database ke Worker `latih-proxy` yang sudah ada
   (lewat Settings > Bindings di dashboard Worker).

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
   `/sync/pull`, `/blob/:id` (PUT untuk upload, GET untuk ambil).
3. Di `index.html`: setiap `idbPut(...)` yang sudah ada juga memicu push ke
   cloud (mirip pola `scheduleCloudPush()` di app Tunas), dan saat app dibuka
   akan pull + merge dari cloud sebelum render.
4. Tambah UI baru: pemilih rentang tanggal untuk fitur download murni
   audio/video dan fitur hapus riwayat massal (poin 5), diterapkan ke ke-4
   jenis riwayat (Ketik, Voice, Video, Baca).
5. Naikkan `APP_VERSION` (sekarang `v1.4.4`) dan `DB_VERSION` IndexedDB kalau
   ada perubahan skema store lokal.
6. Commit & push ke repo `latih-inggris`.

**Catatan untuk chat baru:** kalau ada 1 saja langkah di section 7 yang
belum kamu lakukan, bilang ke AI supaya dipandu dulu step-by-step sebelum
lanjut ke section 8 — soalnya D1/R2 binding harus ada dulu sebelum kode di
Worker bisa dites jalan.
