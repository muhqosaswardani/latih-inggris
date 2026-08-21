# Setup LATIH. biar API key aman (± 5-10 menit, gratis)

Ini cuma perlu dilakukan **SEKALI**. Setelah ini, `index_bahasa_inggris.html`
kamu aman dipublikasikan ke GitHub Pages / repo publik, karena API key
Gemini yang asli disimpan di server Cloudflare, bukan di file HTML.

Kamu gak perlu install apa-apa di komputer. Semua lewat browser.

---

## Status setup kamu (sudah selesai)

- Worker: `latih-proxy`
- URL Worker: `https://latih-proxy.muhqosaswardani.workers.dev`
- Secret `GEMINI_KEYS`: sudah di-set di Settings > Variables and Secrets
- `PROXY_URL` di `index_bahasa_inggris.html`: sudah diisi dengan URL di atas

File-file di bawah ini didokumentasikan untuk jaga-jaga kalau suatu saat
kamu perlu setup ulang atau pindah akun Cloudflare.

---

## Langkah 1 - Bikin akun Cloudflare (gratis)

1. Buka https://dash.cloudflare.com/sign-up
2. Daftar pakai email kamu (gratis, gak perlu kartu kredit).
3. Verifikasi email kalau diminta.

## Langkah 2 - Bikin Worker

1. Di dashboard Cloudflare, buka **Compute > Workers** di sidebar kiri.
2. Klik **Create application** > **Start with Hello World!**.
3. Kasih nama, misalnya `latih-proxy` (nama ini akan jadi bagian dari URL kamu).
4. Klik **Deploy**.

## Langkah 3 - Tempel kode Worker

1. Setelah Worker-nya jadi, klik **Edit code**.
2. Kamu akan lihat editor kode di browser. **Hapus semua isi default-nya** (Ctrl+A lalu hapus).
3. Buka file `cloudflare-worker.js`, **copy semua isinya**, lalu **paste** ke editor Cloudflare tadi.
4. Klik **Deploy** (di pojok kanan atas editor).

## Langkah 4 - Set API key sebagai Secret (bagian paling penting!)

Ini yang bikin key kamu aman - disimpan terpisah dari kode, gak akan pernah muncul di file manapun.

1. Balik ke halaman utama Worker (klik nama Worker di pojok kiri atas, bukan tab editor).
2. Buka tab **Settings** > **Variables and secrets**.
3. Klik **+ Add variable**.
4. Isi:
   - **Key**: `GEMINI_KEYS`
   - **Value**: (paste semua API key kamu, dipisah koma, TANPA spasi. Contoh format di bawah)
   - Pilih tipe **Secret** (bukan "Text"/plaintext) - biar gak kelihatan siapa pun termasuk kamu sendiri setelah disimpan.
5. Klik **Add 1 variable**. Cloudflare langsung menyimpannya otomatis.

Format value-nya (ganti dengan key kamu, dipisah koma tanpa spasi setelah koma):
```
key1,key2,key3,key4
```

## Langkah 5 - Catat URL Worker kamu

1. Masih di halaman Worker, di bagian atas biasanya ada URL seperti:
   `https://latih-proxy.NAMAKAMU.workers.dev`
2. **Copy URL itu.**

## Langkah 6 - Tempel URL ke file HTML

1. Buka `index_bahasa_inggris.html` pakai text editor apa saja.
2. Cari baris ini (dekat bagian atas `<script>`):
   ```js
   var PROXY_URL = 'ISI_DENGAN_URL_WORKER_KAMU';
   ```
3. Ganti jadi URL Worker kamu dari Langkah 5, contoh:
   ```js
   var PROXY_URL = 'https://latih-proxy.namakamu.workers.dev';
   ```
4. Simpan file.

## Langkah 7 - Selesai, tes dulu

1. Buka `index_bahasa_inggris.html` itu di browser (boleh dobel-klik langsung dari HP/komputer).
2. Coba tab **Ketik**, tulis kalimat bahasa Inggris, klik "Kirim untuk direview".
3. Kalau muncul hasil koreksi = berhasil, Worker-nya jalan.
4. Kalau ada error, cek lagi: URL di Langkah 6 udah bener? Secret `GEMINI_KEYS` di Langkah 4 udah ke-save?

---

## Sekarang aman untuk di-upload ke repo

Setelah `PROXY_URL` diisi (bukan lagi memanggil Gemini langsung dengan key
tertanam), file `index_bahasa_inggris.html` ini **tidak lagi mengandung
API key apa pun**. Aman untuk:
- Di-push ke repo (private ATAU public, keduanya aman sekarang)
- Di-deploy ke GitHub Pages
- Dipasang sebagai PWA nantinya

`cloudflare-worker.js` dan `README_SETUP.md` ini boleh ikut disimpan di
repo juga (isinya gak ada key rahasia) - berguna kalau suatu saat kamu
perlu setup ulang atau pindah akun.

## Kalau nanti mau ganti/rotate key

Karena key sekarang cuma ada di satu tempat (Settings > Variables and secrets di
Cloudflare), gampang banget diganti:
1. Buka Google AI Studio, generate API key baru (dan hapus/revoke yang lama kalau pernah bocor).
2. Balik ke Cloudflare > Worker kamu > Settings > Variables and secrets > edit `GEMINI_KEYS`.
3. Gak perlu ubah apa pun di file HTML/repo.

**Catatan keamanan:** kalau kamu pernah menempel API key mentah-mentah di
suatu tempat yang tercatat/tersimpan di luar Cloudflare Secrets (chat, dokumen,
screenshot, dsb), anggap key itu sudah terekspos. Sebaiknya generate ulang
semua key di Google AI Studio dan update `GEMINI_KEYS` dengan yang baru.
