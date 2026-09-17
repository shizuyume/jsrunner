# 🚀 Local Service Runner

> Jalankan banyak project JavaScript/TypeScript sekaligus dari satu dashboard — tanpa perlu membuka belasan terminal.

**Local Service Runner** adalah aplikasi ringan untuk menggantikan banyak terminal saat kamu mengembangkan banyak project sekaligus. Cukup pilih `package.json`, dan semua service (frontend, backend, gateway, worker) berjalan dari satu dashboard yang rapi.

> ⚠️ **Catatan:** Tools ini khusus untuk **komputer lokal / development** — bukan deployment manager, bukan Docker manager, dan bukan process manager untuk production.

[![npm version](https://img.shields.io/npm/v/@shizuyume/jsrunner)](https://www.npmjs.com/package/@shizuyume/jsrunner)
[![npm downloads](https://img.shields.io/npm/dm/@shizuyume/jsrunner)](https://www.npmjs.com/package/@shizuyume/jsrunner)
[![Node](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)

---

## ✨ Fitur Unggulan

| | Fitur | Deskripsi |
|---|---|---|
| 🖥️ | **Dashboard Card** | Setiap project jadi kartu: nama, framework, package manager, folder, port, PID, status, uptime, group |
| 📂 | **Workspace Scan** | Cukup masukkan **satu path folder** — semua service di dalamnya terdeteksi, bisa dicari & dipilih lalu ditambahkan sekaligus |
| ⚙️ | **Auto Scan** | Backend otomatis mendeteksi framework, package manager, port, dan sub-project |
| 📜 | **Dynamic Script** | Semua script di `package.json` muncul otomatis — tanpa hardcode |
| 🎛️ | **Run Settings** | Pilih script mana yang dipakai Start, custom command, dan env var per project |
| 🔗 | **Start Dependency** | `api` bisa menunggu `db` & `auth` benar-benar listening sebelum jalan |
| 🚦 | **Health Check** | Status `Starting` sampai port benar-benar menerima koneksi, lalu tombol **Open** muncul |
| ⚡ | **Realtime via SSE** | Push dari server (bukan polling); log tampil seketika, indikator hijau di header |
| 🎨 | **Log Berwarna** | Kode ANSI dirender jadi warna asli, plus filter, download `.log`, dan riwayat tersimpan di disk |
| 🚧 | **Port Conflict Guard** | Sebelum start, port dicek — kalau bentrok, ditunjukkan process pemakainya + opsi kill |
| ▶️ | **Control Penuh** | Start, Stop, Restart, Install, Build, dan Custom Script per project |
| 📊 | **Realtime Log** | Log per process via SSE (tanpa websocket) — copy, clear, pause auto-scroll |
| 🔎 | **Search** | Cari realtime berdasarkan nama, folder, port, framework, atau group |
| 🗂️ | **Group** | Kelompokkan project, bisa collapse, plus aksi Start/Stop/Restart All per group |
| 🎬 | **Profile / Preset** | Satu klik "Start POS demo" — sekumpulan service **lintas group**, mode **parallel** atau **sequential** dengan urutan yang bisa diatur |
| 💥 | **Crash Detection** | Status otomatis jadi `Crashed` saat process mati tak wajar — status di config ikut dikoreksi, bukan cuma di UI |
| 🛡️ | **Auto Restart** | Toggle per project; crash → restart otomatis, dengan guard anti crash-loop (maks 3× / 60 detik) |
| 📈 | **CPU & Memory** | Pemakaian realtime per project, dihitung dari **seluruh process tree** (cmd → npm → node) |
| 🔗 | **Re-attach Orphan** | Server mati paksa? Saat start ulang, service yang masih hidup diadopsi kembali (via PID atau port) — Stop/Restart langsung berfungsi |
| 🔌 | **Port Manager** | Ganti port project langsung dari UI, hindari konflik port antar service |
| 📌 | **Recent Projects** | Project terakhir dijalankan tampil di strip atas, bisa dihapus |
| 🌙 | **Dark Mode** | UI gelap, responsive, card layout murni CSS Variables — tanpa framework CSS |

---

## 🧱 Teknologi

| Lapisan | Teknologi |
|---|---|
| **Backend** | Node.js — Native ES Module (`.mjs`) |
| **Frontend** | HTML + CSS + Vanilla JavaScript |
| **Database** | ❌ Tidak ada — semua data di `config/projects.json` |
| **Dependency** | ❌ **Nol package npm** — murni built-in Node.js |

Tanpa Express, React, Vue, Electron, SQLite, MongoDB, Socket.io. Ringan dan portable.

---

## 🏗️ Arsitektur

**Alur request** — satu server HTTP, router internal memisahkan API dan file statis:

```
Browser (dashboard)
     │  HTTP (fetch / polling)
     ▼
server/server.mjs ──── router.match() ────────────────┐
     │                                                │
     │  /api/*                                        │  bukan /api/*
     ▼                                                ▼
api/*.mjs (handler per domain)               serveStatic(PKG_ROOT/public)
     │                                                │
     ├── utils/config.mjs ──► config/projects.json    │  index.html
     ├── utils/process.mjs ──► spawn / kill proses     │  css/
     ├── utils/logger.mjs ──► buffer log per project   │  js/
     ├── utils/scanner.mjs ──► deteksi framework/pm    │
     └── utils/port.mjs ──► rewrite config port        │
```

**Penyimpanan** — satu file JSON sebagai satu-satunya "database":

```
UI ──► REST API ──► utils/config.mjs ──► config/projects.json
     ▲                                        │
     └────────── auto-save tiap perubahan ◄────┘
```

**Lifecycle process** — setiap project independen, crash terdeteksi & bisa auto-restart:

```
stopped ──► starting ──► running ──► crashed
   ▲           │            │  ▲        │
   └───────────┴────────────┘  └─ error ─┤
                                         │ autoRestart=true
                                         ▼
                                    (2 detik) ──► running
```

**Log & metrics** — tanpa websocket, polling ringan: UI tarik log baru via `GET /api/project/:id/logs?after=<id>`.

---

## 📦 Persyaratan

- **Node.js** v18 ke atas
- **Windows, macOS, atau Linux** — semua primitif OS (spawn shell, kill process tree, baca tabel port) diisolasi di `utils/platform/`
- Tidak perlu `npm install` sama sekali ✅

| OS | Shell | Kill tree | Tabel process | Listener port |
|---|---|---|---|---|
| **Windows** | `cmd.exe /d /s /c` | `taskkill /T /F` | CIM (`Win32_Process`) | `netstat -ano` |
| **Linux** | `sh -c` (process group) | `SIGKILL` ke process group | `/proc` | `ss` → `lsof` |
| **macOS** | `sh -c` (process group) | `SIGKILL` ke process group | `ps` | `lsof` → `ss` |

> Kalau `ss`/`lsof` tidak terpasang, port conflict guard turun pangkat jadi tes bind biasa — tetap jalan, cuma kurang akurat.

---

## 🚀 Cara Menjalankan

**Opsi 1 — Install global via npm** (paling cepat, auto-update notice):

```bash
npm install -g @shizuyume/jsrunner

# Jalankan dari folder mana pun — config dibuat di folder tersebut
jsrunner
```

> ⬆️ Saat versi baru dirilis, server menampilkan notif update di terminal:
> `npm install -g @shizuyume/jsrunner@latest`

**Opsi 2 — Clone repository** (untuk development):

```bash
# 1. Clone repository
git clone https://github.com/<username>/service-runner.git
cd service-runner

# 2. Jalankan server
node server/server.mjs

# 3. Buka dashboard
# Browser otomatis terbuka di:
http://localhost:9999
```

### Konfigurasi Environment

| Variable | Default | Fungsi |
|---|---|---|
| `PORT` | `9999` | Port dashboard |
| `WORKDIR` | direktori sekarang | Lokasi root untuk melayani file statis |

```bash
# Contoh: jalankan di port lain
PORT=9876 node server/server.mjs
```

---

## 📖 Panduan Penggunaan

### 1️⃣ Menambahkan Project (Folder Scan)

Cukup **satu path folder** — tidak perlu menunjuk `package.json` satu per satu.

1. Klik tombol **➕ Add Project** di kanan atas.
2. Masukkan **path folder / workspace**, misal `D:/Works/Neuron`.
3. Pilih **Scan depth** (default 3 level) → klik **Scan Folder**.
4. Backend menelusuri folder dan menampilkan **semua service** yang ditemukan (setiap `package.json`), lengkap dengan:
   - Nama & path relatif
   - Framework & package manager
   - Port yang terdeteksi
   - Penanda **monorepo root**, **no run script**, dan **already added**
5. Centang service yang ingin ditambahkan (service yang punya script `dev`/`start` otomatis tercentang), pilih group — default memakai nama folder workspace.
6. Klik **Add Selected** → semua service masuk dashboard sekaligus. ✅

Picker-nya punya **search** — lihat [Search di daftar pilihan](#-search-di-daftar-pilihan) di bawah.

> 📁 Folder `node_modules`, `dist`, `build`, `.git`, dan sejenisnya dilewati saat scan.
> 🔁 **Duplicate Protection:** Project dengan `package.json` yang sama tidak bisa ditambahkan dua kali — barisnya tampil non-aktif dengan label *already added*.
> ➕ Endpoint `POST /api/project` tetap menerima path folder **maupun** path `package.json` untuk penambahan satu project.

### 🔎 Search di daftar pilihan

Tiga dialog memakai daftar pilihan yang sama dan semuanya punya kolom search di atasnya:

| Dialog | Dicari berdasarkan |
|---|---|
| **Add Project** (picker hasil scan) | nama, path folder, framework, package manager, port, nama script |
| **Dependencies** | nama, group, framework, port |
| **Profile** (pilih anggota) | nama, group, framework, package manager, port |

| Contoh query | Hasil |
|---|---|
| `mcs` | semua service `@mcs/...` |
| `nestjs` | semua service NestJS |
| `4001` | service dengan port 4001 |
| `mcs resource` | multi-kata = AND, harus cocok keduanya |

Aturan yang berlaku di ketiganya:

- **Pilihan tidak hilang saat filter berubah.** Hitungan `6 selected · 2 of 11 shown` menunjukkan total pilihan berbanding yang sedang tampil, dan Save/Add tetap menyertakan pilihan yang sedang tersembunyi.
- Tombol bulk (**Select all / Clear all / Only runnable**) bekerja pada **baris yang sedang terlihat**. Jadi alurnya bisa: cari `mcs` → Select all → cari `portal` → Select all → dua-duanya terpilih.
- Baris `already added` tetap non-aktif dan tidak tersentuh tombol bulk.
- Di dialog Profile, judul group ikut tersembunyi kalau semua isinya tersaring.
- `Esc` di kolom search mengosongkan filter dulu; `Esc` kedua baru menutup dialog.

### 2️⃣ Menjalankan & Mengontrol Project

Setiap card punya tombol aksi:

| Tombol | Fungsi |
|---|---|
| ▶️ **Start** | Menjalankan process |
| ⏹️ **Stop** | Menghentikan process |
| 🔄 **Restart** | Menjalankan ulang process |
| ⬇️ **Install** | `npm/yarn/pnpm/bun install` |
| 🏗️ **Build** | Menjalankan script `build` |
| 🧪 **Custom Script** | Menjalankan script lain dari `package.json` |
| ↗️ **Open** | Muncul saat port sudah menerima koneksi — buka `http://localhost:<port>` |

Setiap process berjalan independen dengan **PID sendiri** — banyak service jalan bersamaan tanpa saling mengganggu.

#### Run Settings (🎛️)

Secara default Start memakai script `dev`, lalu `start`, lalu script pertama. Lewat dialog **Run Settings** kamu bisa mengatur per project:

| Pengaturan | Fungsi |
|---|---|
| **Start script** | Pilih script mana yang dipakai Start — berguna untuk repo dengan `dev:party-service`, `dev:gateway`, dst. |
| **Custom command** | Timpa sepenuhnya, misal `node server.js --inspect` — dijalankan di folder project |
| **Environment variables** | Format `KEY=value` satu per baris; ditambahkan ke env process anak |

Perubahan berlaku pada start berikutnya (toast mengingatkan kalau project sedang jalan).

#### Start Dependency (🔗)

Untuk microservice yang saling bergantung, tandai project mana yang harus siap lebih dulu. Saat Start:

1. Semua dependency dijalankan lebih dulu (rekursif, urutan terdalam dulu).
2. Runner **menunggu port masing-masing benar-benar menerima koneksi** — bukan sekadar "process sudah spawn".
3. Baru project utamanya dijalankan.

Selama menunggu, statusnya `Starting` dan progresnya terlihat di log:

```
[runner] dependencies first: db, slow
[runner] waiting for db on port 5501…
[runner] db is ready
[runner] waiting for slow on port 5502…
[runner] slow is ready
[runner] npm run dev (port 5503)
```

Dependency circular ditolak saat disimpan. Project tanpa port hanya dijalankan, tidak ditunggu. Batas tunggu 90 detik — setelah itu project utama tetap dijalankan disertai catatan di log.

### 3️⃣ Melihat Log

Klik ikon terminal pada card untuk membuka panel **Realtime Log**:

- 🎨 **Warna ANSI** — output berwarna dari dev server dirender apa adanya, bukan `[32m✓[39m`
- 🔍 **Filter** — saring baris secara realtime, dengan hitungan `4 / 120 lines`
- 📋 **Copy Log** — salin seluruh output (escape code dibersihkan)
- 💾 **Download** — simpan sebagai `<nama>-<timestamp>.log`
- 🧹 **Clear Log** — bersihkan buffer sekaligus file di disk
- ⏸️ **Pause Auto Scroll** — otomatis aktif saat kamu scroll ke atas

**Log tersimpan di disk** (`logs/<projectId>.log`, rotasi pada 2 MB). Setelah server restart, panel menampilkan riwayat run sebelumnya dengan penanda:

```
——— end of saved log (previous run) ———
```

Pengiriman log memakai **SSE** — server memberi tahu saat ada output baru, jadi tidak ada polling saat semuanya diam. Indikator titik di header: **hijau** = live, **kuning** = stream terputus, sementara jatuh ke polling 2 detik.

### 4️⃣ Mengelompokkan Project

Kelola project dalam group, misalnya:

```
TMF
├── Gateway
├── Product
└── Inventory

POS
├── Backend
└── Frontend
```

- Buat / rename / hapus group lewat UI
- Group bisa **collapse** agar dashboard rapi
- Aksi **Start All / Stop All / Restart All** per group

### 4️⃣.5 Profile / Preset — satu klik untuk satu set service

Group untuk **merapikan dashboard**; profile untuk **"apa yang saya butuhkan jalan sekarang"**. Profile boleh mengambil project dari group mana pun.

Strip **Profiles** ada di bawah header:

```
Profiles   ▶ POS demo 0/3   ▶ Reporting 2/2   + New profile
```

- Klik nama profile → semua anggotanya start. Saat semua sudah siap, tombolnya berubah jadi **Stop**.
- Angka `2/3` = berapa anggota yang **benar-benar siap melayani** (definisi yang sama dengan pill di card, bukan hanya "process hidup").
- Badge `SEQ` menandai profile bermode sequential.
- Ikon ✏️ untuk edit (rename, mode, anggota, urutan), ✕ untuk hapus profile. Menghapus profile **tidak** menghapus project-nya.

#### Start mode: Parallel atau Sequential

Dipilih per profile di dialog Edit:

| Mode | Perilaku |
|---|---|
| **Parallel** (default) | Semua anggota start sekaligus. Dependency tetap dihormati — tiap anggota hanya menunggu project yang benar-benar jadi dependency-nya. |
| **Sequential** | Anggota dijalankan **satu per satu sesuai urutan**. Service kedua tidak akan di-start sebelum service pertama benar-benar **ready** (port-nya menjawab). |

Daftar anggota bisa dicari (lihat [Search di daftar pilihan](#-search-di-daftar-pilihan)); panel **Start order** tidak ikut tersaring supaya urutan penuh selalu terlihat.

Urutan diatur di panel **Start order** dalam dialog: **drag baris** lewat handle ⠿, atau pakai tombol ↑ / ↓ (tetap ada untuk keyboard dan langkah presisi). Garis biru menunjukkan posisi jatuhnya baris. Project yang baru dicentang masuk ke urutan paling bawah. Di mode parallel panel ini ditampilkan redup karena urutannya tidak berpengaruh.

Perbandingan nyata dari pengujian — tiga service (`a` butuh 3 detik warm-up, `b` dan `c` masing-masing 1 detik):

```
SEQUENTIAL (a → b → c), total ±8s
t+1s  a=run/wait  b=stopped    c=stopped
t+4s  a=READY     b=run/wait   c=stopped     ← b baru start setelah a READY
t+6s  a=READY     b=READY      c=run/wait    ← c baru start setelah b READY
t+8s  a=READY     b=READY      c=READY

PARALLEL, total ±4s
t+1s  a=run/wait  b=run/wait   c=run/wait
t+3s  a=run/wait  b=READY      c=READY
t+4s  a=READY     b=READY      c=READY
```

Dua catatan penting soal mode sequential:

- **Service tanpa port tidak bisa di-probe** — runner tidak punya cara tahu kapan ia "siap", jadi langkah berikutnya jalan segera setelah process-nya spawn. Ini dicatat di log.
- **Kalau satu langkah gagal spawn, langkah sesudahnya dilewati** — justru itu alasan memakai sequential. Log-nya jelas:

  ```
  [runner] step 1/2 of the profile
  [runner] failed to start: No scripts available for project p_xyz
  [runner] skipped — svc-broken failed to start        ← di log service berikutnya
  ```

**Start profile menghormati dependency** di kedua mode. Semua anggota + dependency-nya diselesaikan sebagai satu graph, jadi:

| Situasi | Yang terjadi |
|---|---|
| Dua anggota berbagi satu dependency (`db`) | `db` dijalankan **satu kali**, keduanya menunggu `db` siap |
| Anggota tanpa dependency (mode parallel) | Langsung jalan — tidak ikut mengantre di belakang `db` orang lain |
| Anggota sudah running | Dilewati, tidak di-restart |
| Dependency circular | Edge yang menutup lingkaran diabaikan, tidak deadlock |

Contoh nyata (mode parallel) — `admin-panel` (tanpa dependency) siap di detik ke-3, sementara `pos-backend` & `pos-frontend` menunggu `pos-db` yang butuh 4 detik warm-up:

```
t+1.5s  chip=0/3   admin=Starting  backend=Starting  db=Starting  frontend=Starting
t+3.0s  chip=1/3   admin=Running   backend=Starting  db=Starting  frontend=Starting
t+7.5s  chip=1/3   admin=Running   backend=Starting  db=Running   frontend=Starting
t+9.0s  chip=3/3   admin=Running   backend=Running   db=Running   frontend=Running
```

> **Stop profile hanya menghentikan anggotanya**, bukan dependency-nya — `db` bisa jadi masih dipakai service lain di luar profile ini. Hentikan `db` dari card-nya kalau memang perlu.

Profile disimpan di **`config/profiles.json`** (terpisah dari `projects.json`). Project yang dihapus otomatis dibersihkan dari semua profile.

```json
[
  {
    "id": "pf_abc123",
    "name": "POS demo",
    "projectIds": ["p_backend", "p_frontend", "p_admin"],
    "mode": "sequential",
    "color": "hsl(210, 60%, 50%)"
  }
]
```

> Urutan `projectIds` **adalah** urutan start di mode sequential. Di mode parallel urutannya tidak berpengaruh.

### 5️⃣ Mencari Project

Gunakan kolom search di header. Pencarian **realtime** berdasarkan:

- Nama project
- Folder
- Port
- Framework
- Group

### 6️⃣ Ganti Port (Port Manager)

Cegah konflik port antar service:

1. Klik tombol **Change Port** pada card.
2. Masukkan port baru (rentang valid: `1` – `65535`).
3. Backend otomatis **rewrite file konfigurasi** (bukan `.env`), lalu rescan & update UI.

File yang didukung: `.env.local`, `.env.development`, `vite.config.js/ts`, `next.config.js/mjs`, `package.json` script, `angular.json`, `nest-cli.json`.

> ⛔ Jika file tidak didukung → **"Port configuration not supported."**

#### Port Conflict Guard

Sebelum start, port project dicek lewat tabel listener milik OS — `netstat` di Windows, `ss`/`lsof` di Linux & macOS — bukan sekadar percobaan bind, karena server yang listen di `::` tidak selalu memblokir bind ke `127.0.0.1`. Kalau bentrok, start dibatalkan dan dialog menampilkan **process yang memegang port itu**:

```
Port 5503 In Use
Held by  node.exe · PID 54040
"C:\Program Files\nodejs\node.exe" -e "require('http')..."

[ Cancel ]  [ Change Port ]  [ Kill PID 54040 & Start ]
```

**Kill & Start** membebaskan port lalu langsung mencoba start ulang. Process sistem (PID ≤ 4) dan port milik dashboard sendiri ditolak.

### 7️⃣ Monitoring & Pemulihan

**Crash Detection**
Saat process mati dengan exit code ≠ 0, backend menulis status `Crashed` ke config, mengosongkan PID, dan dashboard menampilkan pill `Crashed` + toast `<nama> crashed`. `GET /api/projects` selalu direkonsiliasi dengan kondisi process yang sebenarnya — status `Running` palsu tidak bisa bertahan.

**Auto Restart** (tombol 🛡️ di footer card)
Aktif per project. Jika crash → tunggu 1,5 detik → start ulang otomatis, maksimal **3 kali dalam 60 detik**. Setelah batas itu tercapai, restart dihentikan dan log mencantumkan alasannya:

```
[runner] crashed with exit code 1 — auto-restarting (1/3) in 1.5s
[runner] auto-restarted (PID 33072)
[runner] auto-restart stopped after 3 attempts in 60s — fix the crash and start manually
```

Stop atau Start manual otomatis membatalkan restart yang sedang menunggu.

**CPU & Memory**
Ditampilkan di card saat project running. Dihitung dari total **process tree**, karena PID yang dilacak adalah wrapper shell (`cmd.exe` di Windows, `sh` di Unix) — mengukur PID itu saja akan selalu menghasilkan 0%. CPU dinormalisasi terhadap jumlah core (sama seperti Task Manager). Sampling memakai satu snapshot process table per interval (CIM di Windows, `/proc` di Linux, `ps` di macOS) dan **berhenti total saat tidak ada project yang jalan**. Angka ini hanya di memori, tidak pernah ditulis ke `projects.json`.

**Re-attach Orphan Process**
Kalau server dimatikan paksa (bukan Ctrl+C), service tetap hidup tanpa pengelola. Saat server start ulang, setiap project berstatus `running` dicoba diadopsi:

1. **Via PID** — PID tersimpan masih hidup dan image-nya dikenali (Windows: `cmd.exe`/`node.exe`/`bun.exe`/`deno.exe`; Unix: `sh`/`bash`/`node`/`npm`/`bun`/`deno`).
2. **Via port** — PID tersimpan sudah mati (hard kill sering membunuh wrapper shell tapi menyisakan `node` di bawahnya), tapi port project masih dipegang process yang dikenali.

Yang berhasil diadopsi tampil dengan badge `re-attached` dan **Stop/Restart-nya berfungsi normal**; log lama tidak tersedia (stdio-nya sudah hilang) sampai project di-restart. Yang tidak bisa diidentifikasi ditandai `stopped`. Adopsi sengaja dibuat konservatif — PID bisa didaur ulang OS, dan salah membunuh process orang lain jauh lebih buruk daripada kehilangan jejak satu service.

- **Start All / Stop All** — kontrol semua project dari header (tombol **Stop All**).
- **Recent Projects** — project terakhir muncul di strip atas; ada tombol hapus per item.
- **Sub-project → Card** — sub-project yang terdeteksi tampil di bagian bawah card. Tombol **+ Card** menjadikannya project tersendiri, sehingga punya Start/Stop, log, metrics, dan auto-restart sendiri (sebelumnya hanya bisa diganti port-nya).
- **Edit Path** — ubah lokasi `package.json` dari dialog; backend otomatis validasi → rescan → update config.
- **Rescan** — baca ulang `package.json`; UI ikut berubah jika script/nama/framework/port berubah.
- **Auto Save** — semua perubahan tersimpan otomatis, tanpa tombol Save. 💾

---

## 🔍 Deteksi Otomatis

### Framework

React · Vite · Next · Node · Express · NestJS · Nuxt · Vue · Angular · Astro

Jika tidak dikenal → `Unknown`.

### Package Manager

Prioritas deteksi dari lockfile:

```
bun.lockb      → bun
pnpm-lock.yaml → pnpm
yarn.lock      → yarn
package-lock.json → npm
```

Semua perintah mengikuti package manager project, misal `pnpm dev`, `bun dev`, `npm run dev`, atau `yarn dev`.

---

## 📡 REST API

| Method | Endpoint | Fungsi |
|---|---|---|
| `GET` | `/api/projects` | Daftar semua project |
| `POST` | `/api/project` | Tambah project (path folder atau `package.json`) |
| `POST` | `/api/workspace/scan` | Scan folder/workspace → daftar service yang ditemukan |
| `POST` | `/api/workspace/add` | Tambah banyak service hasil scan sekaligus |
| `POST` | `/api/project/start` | Start project |
| `POST` | `/api/project/stop` | Stop project |
| `POST` | `/api/project/restart` | Restart project |
| `POST` | `/api/project/autorestart` | Aktif/matikan auto restart saat crash |
| `POST` | `/api/project/runconfig` | Set start script / custom command / env var |
| `POST` | `/api/project/deps` | Set dependency start order |
| `POST` | `/api/port/kill` | Bunuh process yang memegang sebuah port |
| `GET` | `/api/events` | Stream SSE: status project + notifikasi log |
| `POST` | `/api/project/script` | Jalankan script / custom script |
| `POST` | `/api/project/script/cancel` | Batalkan script berjalan |
| `POST` | `/api/project/rescan` | Scan ulang `package.json` |
| `POST` | `/api/project/path` | Ubah lokasi `package.json` |
| `POST` | `/api/project/port` | Ganti port project |
| `POST` | `/api/project/group` | Set group project |
| `POST` | `/api/group/rename` | Rename group |
| `POST` | `/api/group/delete` | Hapus group |
| `GET` | `/api/profiles` | Daftar profile |
| `POST` | `/api/profiles` | Buat profile (`name`, `projectIds` terurut, `mode`) |
| `PUT` | `/api/profiles/:id` | Rename / ubah anggota, urutan, dan mode |
| `DELETE` | `/api/profiles/:id` | Hapus profile |
| `POST` | `/api/profiles/:id/start` | Start semua anggota + dependency-nya (ikut mode profile) |
| `POST` | `/api/profiles/:id/stop` | Stop anggota profile (dependency dibiarkan) |
| `GET` | `/api/project/:id/logs` | Ambil log project |
| `POST` | `/api/project/:id/logs/clear` | Bersihkan log |
| `DELETE` | `/api/project/:id` | Hapus project dari config |

---

## 📁 Struktur Folder

```
service-runner/
├── server/          # HTTP server, router, static file
│   ├── server.mjs   # Entry point
│   ├── router.mjs   # Router minimalis (tanpa framework)
│   └── static.mjs   # Static file server
├── api/             # Route handlers per domain
│   ├── projects.mjs
│   ├── control.mjs  # start / stop / restart
│   ├── script.mjs   # dynamic & custom script
│   ├── logs.mjs
│   ├── port.mjs     # port manager
│   ├── path.mjs     # edit path
│   ├── workspace.mjs # scan folder + bulk add service
│   ├── events.mjs   # SSE stream (status + notifikasi log)
│   ├── profiles.mjs # CRUD + start/stop profile
│   └── group.mjs
├── utils/           # Logic inti (modular, terpisah)
│   ├── config.mjs   # baca/tulis config/projects.json
│   ├── profiles.mjs # baca/tulis config/profiles.json
│   ├── scanner.mjs  # scan project & workspace, deteksi framework/pm/port
│   ├── project-factory.mjs # bentuk entry config dari folder hasil scan
│   ├── process.mjs  # process manager (spawn, kill, crash, adopt orphan)
│   ├── supervisor.mjs # sinkron status process ↔ config, auto restart, adopsi
│   ├── metrics.mjs  # CPU/memory per process tree
│   ├── health.mjs   # TCP readiness probe + wait-for-port
│   ├── platform/    # 🧱 batas OS — satu-satunya modul yang boleh menyebut
│   │   ├── index.mjs #    primitif OS. Memilih implementasi + helper lintas OS
│   │   ├── win.mjs   #    cmd.exe, taskkill, CIM, netstat
│   │   └── posix.mjs #    sh -c + process group, /proc, ps, ss/lsof
│   ├── script-runner.mjs
│   ├── logger.mjs   # buffer log per process
│   ├── port.mjs     # rewrite konfigurasi port
├── public/          # Frontend vanilla JS
│   ├── index.html
│   ├── css/
│   └── js/          # cards, groups, logs, search, dialogs, recent, profiles,
│                    # events.js (SSE client), ansi.js (ANSI → HTML)
├── logs/            # Riwayat log per project (gitignored, rotasi 2 MB)
└── config/
    ├── projects.json  # "Database" project
    └── profiles.json  # Profile / preset
```

---

## ⚙️ Konfigurasi

Semua data tersimpan di **`config/projects.json`** (+ `config/profiles.json` untuk profile) — tidak ada database. Backup semudah menyalin file-nya.

```json
{
  "id": "p_abc123",
  "name": "my-app",
  "group": "POS",
  "framework": "React",
  "pm": "npm",
  "folder": "D:/project/my-app",
  "path": "D:/project/my-app/package.json",
  "port": 5173,
  "scripts": ["dev", "build", "test"],
  "runScript": "dev",
  "command": null,
  "env": { "NODE_ENV": "development" },
  "dependsOn": ["p_xyz789"],
  "autoRestart": false,
  "status": "stopped",
  "pid": null,
  "startedAt": null
}
```

> `cpu`, `mem`, `health`, dan `url` **tidak** disimpan di file ini — keduanya hanya ada di memori dan ikut di response `GET /api/projects`, supaya `projects.json` tidak ditulis ulang tiap beberapa detik.

---

## 🛠️ Status Implementasi

| Fitur | Status |
|---|---|
| HTTP Server + Router (tanpa framework) | ✅ Selesai |
| Config Manager (`projects.json`) | ✅ Selesai |
| Scanner (framework, PM, port, sub-project) | ✅ Selesai |
| Workspace Scan (folder → multi service picker) | ✅ Selesai |
| REST API | ✅ Selesai |
| Process Manager (multi-process, PID) | ✅ Selesai |
| Dashboard + Dynamic Script | ✅ Selesai |
| Realtime Log (ANSI, filter, download, persist) | ✅ Selesai |
| Realtime via SSE (+ fallback polling) | ✅ Selesai |
| Run Settings (script / command / env per project) | ✅ Selesai |
| Health Check + Open URL | ✅ Selesai |
| Start Dependency (tunggu port dependency siap) | ✅ Selesai |
| Port Conflict Guard + kill pemakai port | ✅ Selesai |
| Search | ✅ Selesai |
| Group + Group Action | ✅ Selesai |
| Profile / Preset (lintas group, sadar dependency) | ✅ Selesai |
| Start mode profile: parallel / sequential berurutan | ✅ Selesai |
| Port Manager | ✅ Selesai |
| Crash Detection + Auto Restart (guard 3×/60s) | ✅ Selesai |
| CPU & Memory Monitor (process tree) | ✅ Selesai |
| Re-attach orphan process saat server start | ✅ Selesai |
| Recent Projects | ✅ Selesai |

---

## 🧑‍💻 Development

Struktur modular dengan separation of concern. Beberapa prinsip yang dipegang:

- ✅ Modular & mudah dibaca
- ✅ Async/Await, tanpa kode duplikat
- ✅ Error handling lengkap
- ✅ Tanpa dependency eksternal
- ✅ Setiap modul kecil, fokus satu tanggung jawab

---

## 📄 Lisensi

MIT License — lihat [LICENSE](LICENSE). Bebas dipakai, dimodifikasi, dan didistribusikan, dengan atribusi.
