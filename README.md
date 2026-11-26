# BahanTepat v2 — revisi

## Fitur
- Role `admin`, `kitchen` (dapur), `supplier`.
- SQLite persisten (`data/bahantepat.sqlite`), tabel dibuat otomatis saat server pertama kali dijalankan.
- Registrasi supplier, profil/lokasi, pengelolaan stok dan harga, tambah item katalog.
- Perhitungan estimasi harga berubah langsung saat kuantitas kg diedit.
- Tombol refresh/hitung ulang, hapus menu, reset menu, dan refresh ranking.
- Gemini API dapat dikonfigurasi melalui `.env` (dibaca otomatis oleh dotenv saat server mulai); fallback demo ditandai secara jelas.
- haloo

## Persyaratan
Node.js 20 atau lebih baru. SQLite tidak perlu dipasang terpisah karena memakai `better-sqlite3`.

## Instalasi dari terminal

```bash
npm install
# Windows PowerShell:
Copy-Item .env.example .env
# macOS / Linux:
# cp .env.example .env

# Buka file .env, ganti GEMINI_API_KEY dengan API key dari Google AI Studio.
# Simpan file, lalu jalankan npm start (atau restart server yang sedang berjalan).

# Buat database, tabel, dan katalog bahan lewat terminal:
npm run db:init

# Jalankan aplikasi:
npm start
```

Buka `http://localhost:3000`. Database dan tabel otomatis dibuat pada `data/bahantepat.sqlite` saat server pertama kali dijalankan.

### Akun demo pertama kali
- Admin: `admin` / `admin12345`
- Dapur: `dapur` / `dapur12345`
- Supplier: `supplier` / `supplier12345`

Ganti semua password demo melalui `.env` sebelum deployment. Seed akun hanya berjalan jika tabel users masih kosong.

## Variabel lingkungan
Lihat `.env.example`. File `.env` harus berada di folder proyek yang sama dengan `server.js`. Server memuatnya otomatis menggunakan `dotenv`. Default model adalah `gemini-3.8-flash`; model bisa diganti tanpa mengubah kode. Setelah mengubah `.env`, hentikan server dengan Ctrl+C lalu jalankan `npm start` kembali. Jangan pernah membagikan API key atau mengunggah file `.env`.

## Database
Tabel: `users`, `sessions`, `ingredients`, `suppliers`, `stocks`, `plans`.
File database tersimpan di `data/bahantepat.sqlite`. Backup cukup dengan menyalin file database saat server berhenti, atau gunakan mekanisme backup SQLite.

## Catatan AI dan data
- Gemini hanya membuat estimasi resep mentah per porsi. Nilai nutrisi dihitung dari katalog secara deterministik.
- Bahan yang belum terpetakan tidak ikut perhitungan gizi/biaya dan akan diberi peringatan.
- Katalog nutrisi, yield factor, harga acuan, supplier demo, dan stok awal adalah data ilustrasi/aproksimasi, bukan data resmi TKPI atau harga pasar terverifikasi.
- Item baru yang ditambahkan supplier memiliki nilai gizi nol sampai admin melengkapi data pangan yang tervalidasi.
- Tanpa `GEMINI_API_KEY`, menu yang tidak memiliki resep fallback tidak akan ditebak; UI menampilkan peringatan.
- Lokasi supplier berupa alamat dan koordinat yang diisi oleh supplier. Jarak pada versi ini merupakan estimasi garis lurus sederhana, bukan jarak/rute jalan.

## Deployment
Gunakan hosting Node.js yang menyediakan persistent disk/volume untuk file SQLite. Jika filesystem hosting bersifat ephemeral, database dapat hilang saat redeploy/restart. Set `DB_FILE` ke direktori persistent volume. Isi `GEMINI_API_KEY`, `SESSION_SECRET` (jika ditambahkan di versi lanjutan), dan password akun awal yang kuat.

## Perlu dilanjutkan sebelum produksi/lomba
1. Ganti katalog demo dengan data TKPI resmi dan cantumkan sumber.
2. Verifikasi harga serta supplier dengan data lapangan.
3. Tambahkan geocoding/rute jalan dan validasi koordinat.
4. Tambahkan audit log, reset password, CSRF/rate limiting, HTTPS, dan kebijakan backup.
5. Lengkapi alur admin untuk memverifikasi nutrisi item katalog baru.
