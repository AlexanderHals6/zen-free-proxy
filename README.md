# zen-free-proxy

Proxy tipis (zero-dependency, Web-standard) untuk memakai **OpenCode Zen free tier** dari klien OpenAI-compatible seperti opencode, tanpa perlu API key berbayar, dan **tanpa server sendiri** — deploy di hosting gratis mana pun yang bisa menjalankan JavaScript edge.

Dibuat dari hasil riset langsung terhadap project [opencode2api](https://github.com/jasonxu114514/opencode2api) dan probe live ke upstream Zen (2026-09-28): inti yang benar-benar dibutuhkan untuk jalur *anonymous free* ternyata hanya ~4 transformasi request + relay SSE. Selebihnya (terjemahan 3 protokol, WebUI, pooling key berbayar) tidak relevan untuk kebutuhan ini.

## Cara kerja

Setiap `POST /v1/chat/completions` diproses sebagai berikut (semua wajib, diverifikasi live:

| Transform | Kenapa |
| --- | --- |
| `User-Agent` dipaksa `opencode/...` | tanpanya upstream balas `403 FreeTierError` |
| `stream` dipaksa `true` + 5 tool inti (`bash edit glob grep read`) digabung ke body | free tier hanya melayani request "agent-shaped"; tanpa 5 tool → `403` |
| Session diubah ke format kanonis `ses_<12hex><14base62>` (hash deterministik dari session klien) | format lain → `403` |
| Forward ke `https://opencode.ai/zen/v1/chat/completions` dengan `Authorization: Bearer public` | kredensial anonymous resmi Zen |
| Kalau klien minta `stream:false`, stream SSE di-kolaps balik jadi satu JSON `chat.completion` | free tier selalu stream; klien non-streaming tetap dapat jawaban normal |

Plus `GET /v1/models` (daftar model gratis), `GET /healthz`, CORS penuh. Stateless — tidak ada penyimpanan apa pun.

## Model gratis yang tersedia (per 2026-09-28, diverifikasi live)

```json
["big-pickle", "space-bunny-free", "longcat-2.5-preview-free",
 "nemotron-3-ultra-free", "nemotron-3.5-lightning-free",
 "mimo-v2.5-free", "mimo-v2.6-flash-free", "ling-3.0-flash-fin-free"]
```

Model di luar daftar ini (termasuk semua `claude-*`, `gpt-*`, `gemini-*` polos) menolak kredensial anonymous dengan `401 Missing API key` — itu keputusan upstream, bukan bug proxy. Daftar bisa di-override lewat env `FREE_MODELS` (koma). Catatan: `deepseek-v4-flash-free`, `jev-1.13-free`, dan `muse-spark-*-contributor-free` muncul di katalog tapi sedang `400/500` dari sisi provider.

## Struktur

```
proxy.js                  ← inti proxy (tanpa platform-specific API)
platforms/cloudflare.js   ← entry Cloudflare Workers
platforms/deno.js         ← entry Deno Deploy
platforms/node.js         ← entry Node 18+ (VPS/Render/Railway/Miget/lokal)
server.mjs                ← entry Vercel (Node server runtime, terdeteksi otomatis)
wrangler.toml             ← konfig Cloudflare
vercel.json               ← konfig Vercel
package.json              ← type: module (buat Node)

Inti hanya memakai `Request`/`Response`/`fetch`/`ReadableStream`/`crypto` — API Web standar, jadi file yang sama jalan di semua platform.

## Konfigurasi (env vars)

| Var | Wajib | Default | Keterangan |
| --- | --- | --- | --- |
| `PROXY_KEY` | ✅ | — | API key pribadi; klien harus kirim `Authorization: Bearer <key>`. Tanpa ini server menolak (401). |
| `UA` | | `opencode/1.18.31 (proxy; edge)` | User-Agent yang diteruskan ke upstream. |
| `UPSTREAM_URL` | | `https://opencode.ai/zen/v1/chat/completions` | Ganti jika endpoint Zen berubah. |
| `TIMEOUT_MS` | | `180000` | Batas waktu request ke upstream (dibungkus `AbortSignal.timeout`). |
| `FREE_MODELS` | | daftar 8 model di atas | Daftar model untuk `/v1/models`, dipisah koma. |
| `PORT` / `HOST` | | `8080` / `0.0.0.0` | Hanya dipakai entry Node. |

## Deploy

### Cloudflare Workers (paling disarankan — no-card, 100k req/hari)

```bash
npm i -g wrangler        # sekali saja
cd zen-free-proxy
wrangler login
wrangler secret put PROXY_KEY     # isi dengan key acak panjang
wrangler deploy
# → https://zen-free-proxy.<subdomain>.workers.dev
```

Free plan Workers: 100.000 request/hari, CPU 10 ms/invocation (I/O jaringan tidak dihitung — proxy ini murni relay, jadi aman), request body maks 100 MB, durasi tidak dibatasi selama klien tetap terhubung.

### Deno Deploy

- Upload repo (atau langsung file `platforms/deno.js`) di https://dash.deno.com → New Project → Deploy.
- Tambah env `PROXY_KEY` di project settings.
- Atau CLI: `deployctl deploy --project=<nama> platforms/deno.js` dengan `--env=PROXY_KEY=...`.

### Vercel

```bash
vercel login && vercel
vercel env add PROXY_KEY
vercel --prod
```

Vercel mendeteksi `server.mjs` di root sebagai Node server entrypoint (`server.listen()` dipanggil saat startup) dan merutekan semua request ke sana, jadi tidak ada rewrite atau pemetaan path yang perlu diatur — routing `/v1/...` dan `/healthz` ditangani inti proxy. Runtime Node dipilih karena Vercel kini merekomendasikannya di atas Edge dan streaming SSE-nya native; `vercel.json` cukup memuat `$schema`.

Catatan penting: **jangan** menambahkan key `functions` berisi `"runtime": "edge"`. Pada skema Vercel, `functions` adalah objek `{glob: {...}}` dan `runtime` di dalamnya berisi nama paket npm runtime, bukan `"edge"`, sehingga bentuk itu gagal validasi (`functions.runtime should be object`).

### Node / VPS / Render / Railway / Miget

```bash
node platforms/node.js
# PROXY_KEY=... PORT=8080 node platforms/node.js
```

## Pakai dari opencode

Targetkan ke URL proxy sebagai provider OpenAI-compatible:

```bash
opencode auth login
# pilih "Other" / custom model provider:
#   Provider base URL : https://zen-free-proxy.<subdomain>.workers.dev/v1
#   API key          : <PROXY_KEY kamu>
```

```jsonc
// ~/.config/opencode/opencode.json
{
  "provider": {
    "zenfree": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Zen Free",
      "options": {
        "baseURL": "https://zen-free-proxy.<subdomain>.workers.dev/v1",
        "apiKey": "<PROXY_KEY>"
      },
      "models": {
        "big-pickle": { "name": "Big Pickle" },
        "space-bunny-free": { "name": "Space Bunny" }
      }
    }
  }
}
```

### Uji cepat (curl)

```bash
# streaming
curl -N https://zen-free-proxy.<subdomain>.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer $PROXY_KEY" -H "Content-Type: application/json" \
  -d '{"model":"big-pickle","stream":true,"messages":[{"role":"user","content":"halo"}]}'

# non-streaming (proxy akan kolaps streaming-nya sendiri)
curl https://zen-free-proxy.<subdomain>.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer $PROXY_KEY" -H "Content-Type: application/json" \
  -d '{"model":"big-pickle","messages":[{"role":"user","content":"halo"}]}'

# daftar model
curl https://zen-free-proxy.<subdomain>.workers.dev/v1/models -H "Authorization: Bearer $PROXY_KEY"
```

## Batasan (diketahui)

- **Hanya Chat Completions** (`/v1/chat/completions`). `/v1/responses` dan `/v1/messages` (Anthropic) sengaja tidak ada — ini proxy tipis, bukan port penuh opencode2api. Kalau butuh ketiganya atau WebUI, gunakan project Open source di atas di VPS (Oracle Always Free, dsb).
- Tool yang "dipaksa" masuk (5 tool inti) muncul di payload yang diteruskan. Kalau klien sudah mengirim tool sendiri, request milik klien tetap dipertahankan — hanya nama yang belum ada yang ditambahkan.
- Daftar model bisa berubah sewaktu-waktu dari sisi OpenCode; `FREE_MODELS` ada untuk update manual.
- Free tier Zen bisa saja mengetatkan gates-nya (seperti yang sudah terjadi beberapa kali). Kalau request tiba-tiba `403 FreeTierError`, cek: UA masih `opencode/*`? 5 tool inti masih ada? session masih kanonis?

## Verifikasi

Test live yang sudah dijalankan terhadap upstream asli (2026-09-28):

- healthz, auth (missing/wrong key → 401), 404 path, bad JSON, missing model
- non-stream request → `200` JSON `chat.completion` berisi jawaban asli (stream dikolaps)
- streaming request → `200 text/event-stream`, event lengkap + `[DONE]`
- tool-call: model dipaksa memanggil tool → `finish_reason: tool_calls` + `tool_calls` utuh di JSON non-stream
- 2 model berbeda (`big-pickle`, `nemotron-3-ultra-free`) → `200`
- error upstream diteruskan apa adanya (model berbayar → `401 Missing API key`)
- server Node asli (HTTP nyata, `Readable.toWeb`) → semua kasus di atas lolos
- entry `server.mjs` Vercel (diimport dengan env, lalu di-request via HTTP nyata) → healthz 200, auth 401, models 8, non-stream terkolaps, stream +`[DONE]`, 404

## Lisensi

MIT — silakan pakai, fork, dan sesuaikan.