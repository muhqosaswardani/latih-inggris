# Serah Terima Eksekusi — Migrasi Cloud LATIH.

Dokumen ini untuk **Antigravity IDE** (atau AI/agent lain yang lanjut kerja di
repo ini). Ditulis oleh Claude (chat), tapi **eksekusi kode selanjutnya
dilakukan Antigravity, bukan Claude**.

Status: **Setup infrastruktur cloud (bagian manual) sudah 100% selesai.
Kode aplikasi BELUM diubah sama sekali.** Semua di bawah ini masih rencana
yang siap dieksekusi.

---

## 0. WAJIB dilakukan pertama kali sebelum menyentuh apa pun

Sebelum membaca/mengedit file apa pun di repo ini, **sinkronkan dulu working
directory lokal dengan `origin/main`** — bisa saja ada perubahan di server
(dari sesi lain, dari pengguna langsung commit lewat GitHub web, dll) sejak
dokumen ini ditulis:

```bash
git fetch origin
git status
# Kalau ada perbedaan / branch lokal ketinggalan:
git pull origin main
```

Jangan asumsikan isi file di bawah ini (skema, versi, dsb) masih akurat
tanpa mengecek ulang kondisi file yang sebenarnya di repo setelah sinkron —
dokumen ini adalah **konteks per 3 September 2026**, bukan sumber kebenaran
mutlak kalau ternyata ada commit baru setelah tanggal itu.

---

## 1. Konteks project

- Repo: `muhqosaswardani/latih-inggris` — aplikasi latihan Bahasa Inggris
  "LATIH." (single-file `index.html`, PWA, IndexedDB lokal).
- Ada 2 dokumen pendamping di root repo ini yang **wajib dibaca duluan**:
  - `RENCANA-MIGRASI-CLOUD.md` — rencana arsitektur lengkap (kenapa Plan B,
    struktur data, spec fitur baru, estimasi kapasitas).
  - `README_SETUP.md` — dokumentasi setup Worker `latih-proxy` yang sudah
    ada sebelumnya (proxy Gemini API).
- Kredensial (token GitHub, info Worker) ada di file terpisah
  `Akses-Repo-Token-LATIH.pdf` yang dipegang pengguna langsung (bukan di
  repo) — kalau chat/agent baru butuh clone repo, minta pengguna upload PDF
  itu atau berikan token secara langsung.

## 2. Yang SUDAH selesai (infrastruktur cloud, manual oleh pengguna)

Semua ini sudah dikerjakan di dashboard Cloudflare pada 3 September 2026,
**tanpa kartu/verifikasi pembayaran** (syarat eksplisit pengguna):

| Resource | Nama | Status |
|---|---|---|
| Cloudflare Workers KV namespace | `latih-media` | ✅ Dibuat |
| Cloudflare D1 database | `latih-db` | ✅ Dibuat |
| Binding KV di Worker `latih-proxy` | variable name **`KV_MEDIA`** → namespace `latih-media` | ✅ Terpasang |
| Binding D1 di Worker `latih-proxy` | variable name **`DB`** → database `latih-db` | ✅ Terpasang |

**PENTING — nama variable ini harus dipakai PERSIS di kode Worker nanti:**
`env.DB` untuk akses D1, `env.KV_MEDIA` untuk akses KV. Jangan pakai nama
lain (mis. `env.MY_DB`, `env.KV`) — binding sudah dikonfigurasi dengan nama
di atas dan tidak bisa dikira-kira ulang tanpa masuk ke dashboard lagi.

Worker `latih-proxy` sendiri sudah lama ada & jalan (proxy Gemini API,
secret `GEMINI_KEYS` sudah diset) — binding baru ini **menambah**
kapabilitas Worker yang sudah ada, bukan bikin Worker baru.

## 3. Yang BELUM dikerjakan (semua kode, tugas Antigravity)

Tidak ada satu baris kode pun yang sudah diubah untuk fitur ini. Berikut
urutan kerja yang disarankan:

### 3.1. Skema tabel D1

Buat & jalankan migration SQL (lewat `wrangler d1 execute latih-db
--file=schema.sql` atau lewat tab Console di dashboard D1) untuk tabel-tabel
berikut, merefleksikan skema IndexedDB yang ada sekarang di `index.html`
(fungsi `idbOpen`, baris ~1450-1475, `DB_VERSION = 7`):

- `ketik` — keyPath `id`, field-field entri Ketik apa adanya (lihat objek
  `entry` yang di-`idbPut('ketik', entry)`, sekitar baris 2437).
- `voice` — keyPath `id`, **TANPA kolom untuk `audioBlob`** (field itu
  disimpan terpisah di KV, tabel D1 cuma simpan `blob_key` referensinya).
  Field lain: transkrip, koreksi, wordTags, pron, meaning, translation,
  meta, ts, dll — lihat objek `entry` di `idbPut('voice', entry)` sekitar
  baris 2885.
- `video` — sama pola dengan `voice` (baris ~3144), **tanpa blob video**,
  cuma `blob_key`.
- `baca` — keyPath `id` (baris ~2603).
- `kamus` — keyPath `word`.
- `kamus_exclude` — keyPath `word` (nama tabel snake_case, di IndexedDB
  namanya `kamusExclude`).

`rekapCache` dan `ttsCache` **TIDAK perlu tabel D1** — keduanya cache lokal
yang boleh digenerate ulang, sudah diputuskan tidak ikut sync (lihat
`RENCANA-MIGRASI-CLOUD.md` bagian 4).

### 3.2. Endpoint baru di `cloudflare-worker.js`

File ini sekarang cuma nangani proxy Gemini (`POST /` dengan `body.mode`).
Tambahkan routing berdasarkan `request.url` pathname untuk endpoint baru,
tanpa mengubah perilaku endpoint lama:

- `POST /sync/push` — terima JSON berisi semua data teks (tags, entri
  ketik/voice/video/baca tanpa blob, kamus, kamusExclude), tulis ke tabel
  D1 via `env.DB.prepare(...).run()`.
- `GET /sync/pull` — baca semua data dari `env.DB`, kembalikan sebagai JSON.
- `PUT /blob/:id` — terima body binary (audio/video), simpan ke
  `env.KV_MEDIA.put(id, arrayBuffer)`.
- `GET /blob/:id` — ambil dari `env.KV_MEDIA.get(id, 'arrayBuffer')`,
  kembalikan sebagai response binary dengan Content-Type sesuai.
- `DELETE /blob/:id` — `env.KV_MEDIA.delete(id)`, dipakai fitur hapus
  riwayat rentang tanggal (lihat 3.4).

Jaga pola CORS & error handling yang sudah ada di file ini (`corsHeaders()`,
`jsonResponse()`) — pakai fungsi yang sama, jangan duplikasi logic baru.

### 3.3. Integrasi ke `index.html`

- Setiap pemanggilan `idbPut(...)` yang sudah ada (baris 2437, 2885, 3144,
  2603, dst — cari semua lewat `grep -n "idbPut("`) juga memicu sync ke
  cloud, mirip pola yang dipakai di app "Tunas" (`scheduleCloudPush()` /
  debounce, lihat repo `tanam-fokus` sebagai referensi pola kalau perlu).
- Untuk entri `voice`/`video`: `audioBlob`/blob video di-upload terpisah ke
  endpoint `PUT /blob/:id` (bukan ikut ke `/sync/push`), field yang dikirim
  ke `/sync/push` cuma `blob_key`-nya.
- Saat app dibuka: pull dari `/sync/pull`, merge dengan data
  IndexedDB lokal berdasarkan `id` (union, bukan timpa — sama prinsipnya
  dengan strategi merge di app Tunas), simpan hasil merge balik ke
  IndexedDB.
- `DB_VERSION` (sekarang `7`) **TIDAK perlu dinaikkan** untuk fitur ini kalau
  tidak ada perubahan struktur object store lokal — cukup dinaikkan kalau
  section 3.4 di bawah butuh index/store baru di IndexedDB.

### 3.4. Fitur baru (spec lengkap ada di `RENCANA-MIGRASI-CLOUD.md` bagian 5)

Berlaku untuk **semua 4 jenis riwayat** (Ketik, Voice, Video, Baca):

1. Download murni file (bukan cuma export JSON gabungan yang sudah ada,
   lihat komentar "Export -> unduh 1 file .json" sekitar baris 1536).
2. Pilih rentang tanggal sebelum download.
3. Hapus riwayat berbasis rentang tanggal (extend dari tombol
   `sheet-delete-btn` / fungsi di sekitar baris 3265-3359 yang saat ini
   cuma hapus 1 entri) — saat hapus, panggil juga `DELETE /blob/:id` ke
   Worker untuk entri Voice/Video yang terhapus, supaya KV tidak menyimpan
   blob yatim (orphan) yang sudah tidak direferensikan tabel D1 manapun.

### 3.5. Versioning & commit

- Naikkan `APP_VERSION` (sekarang `v1.4.4`, baris ~1451 di `index.html`)
  sesuai perubahan yang dibuat.
- Commit dengan pesan yang jelas menyebutkan perubahan (skema D1, endpoint
  Worker, integrasi sync, fitur download/hapus rentang tanggal — bisa
  dipecah jadi beberapa commit logis, tidak harus 1 commit besar).
- Push ke `origin main`.

## 4. Constraint yang wajib dijaga (jangan dilanggar saat eksekusi)

- **Jangan pernah** mengganti KV/D1 dengan R2 — sudah diputuskan ditolak
  karena pengguna tidak mau proses verifikasi kartu (lihat
  `RENCANA-MIGRASI-CLOUD.md` bagian 3).
- **Jangan** menambah dependency Google Drive/OAuth apa pun — sudah
  diputuskan ditolak juga (setup terlalu ribet dibanding manfaatnya).
- **Jangan** hardcode ulang API key Gemini di `index.html` — pola proxy
  lewat Worker (`GEMINI_KEYS` sebagai secret server-side) sudah benar dan
  harus dipertahankan.
- Nama binding **harus** `env.DB` dan `env.KV_MEDIA` persis (lihat bagian
  2) — sudah terpasang di dashboard dengan nama itu, tidak fleksibel.
- `ttsCache` dan `rekapCache` **tidak** ikut disync ke cloud — keputusan
  sudah final (cache regenerable, tidak ada nilai riwayat yang hilang).

## 5. Setelah eksekusi selesai

- Update `RENCANA-MIGRASI-CLOUD.md`: ubah baris "Status" di paling atas
  dari "Rencana... belum dieksekusi" jadi mencerminkan kondisi terbaru
  (mis. "Sudah dieksekusi, versi vX.X.X").
- Dokumen `HANDOFF-EKSEKUSI-ANTIGRAVITY.md` ini (file yang sedang kamu baca)
  boleh dihapus dari repo setelah tidak relevan lagi, atau dibiarkan sebagai
  arsip riwayat keputusan — terserah preferensi pengguna, tanyakan kalau
  perlu kepastian.
