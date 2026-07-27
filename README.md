# CH Media Service

Internal HTTP service that owns the **binary-dependent, CPU-heavy media work** for the
Market Intelligence feature — **yt-dlp**, **ffmpeg**, and **whisper.cpp** — so that the
load-balanced `CHBackend` API ships **no media binaries** and does no transcription.

## Why

`CHBackend` runs under PM2 behind a load balancer. Baking yt-dlp/ffmpeg/Whisper into every
API instance (and running transcription on a web tier) is undesirable. This service isolates
all of that: run it as its own image on a single instance (or a GPU box), on a private
network, reachable only by `CHBackend`/`mi-worker`.

## Endpoints (token-gated)

All requests require `Authorization: Bearer $MEDIA_SERVICE_TOKEN` (unless the token is unset).

- `GET  /health` → `{ status, asrEnabled }`
- `POST /youtube/search` `{ keyword, max? }` → `{ data: [{ url, title }] }` (yt-dlp `ytsearch`)
- `POST /youtube/transcribe` `{ url }` → `{ url, title, text, language, source, meta }`
  - `source` = `"captions"` or `"asr"`.
  - Prefers yt-dlp captions; if none exist **and** `ASR_ENABLED=true`, downloads the audio
    (16 kHz mono WAV via ffmpeg) and transcribes with whisper.cpp.
  - Returns **422** when there's no usable transcript (caller should treat the source as failed).

## Requirements (host / image)

- Node ≥ 20
- `yt-dlp` on `PATH` (or `YTDLP_PATH`)
- `ffmpeg` on `PATH` (or `FFMPEG_PATH`) — needed for audio extraction + resample
- For ASR: `whisper.cpp` CLI (`WHISPER_CPP_PATH`) + a model file (`WHISPER_MODEL_PATH`),
  then set `ASR_ENABLED=true`

## Run

```bash
cp .env.example .env   # set MEDIA_SERVICE_TOKEN (+ whisper paths for ASR)
npm install
npm start              # or: npm run dev
```

Point `CHBackend` at it with `MEDIA_SERVICE_URL` + `MEDIA_SERVICE_TOKEN`.

## Deployment (Debian server, behind Caddy + Cloudflare)

This walks through a bare-metal/VM install on Debian: system binaries, the app as a
systemd service, Caddy as the local reverse proxy/TLS terminator, and Cloudflare in
front of it on a custom domain.

### 1. System packages, Node 20 + the media binaries

`scripts/install-deps.sh` installs Node.js (NodeSource), `yt-dlp` (standalone binary),
`ffmpeg`, and — with `--with-asr` — builds `whisper.cpp` and downloads a ggml model.
It's idempotent, so re-running it just skips/upgrades what's already there.

```bash
# copy the repo to the server first (see step 2), then from its root:
chmod +x scripts/install-deps.sh
sudo ./scripts/install-deps.sh                              # Node + yt-dlp + ffmpeg only
sudo ./scripts/install-deps.sh --with-asr                   # + whisper.cpp + base.en model
sudo ./scripts/install-deps.sh --with-asr --model small.en  # pick a different model
```

At the end it prints the resolved paths to drop into `.env`
(`YTDLP_PATH`, `FFMPEG_PATH`, `WHISPER_CPP_PATH`, `WHISPER_MODEL_PATH`).

Run `./scripts/install-deps.sh --help` for all flags, or do it by hand:

<details>
<summary>Manual install (what the script does)</summary>

```bash
sudo apt update
sudo apt install -y curl git build-essential ca-certificates python3

# Node 20.x via NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # v20.x

# yt-dlp (Debian's apt package is usually too old — use the standalone binary)
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp
yt-dlp --version

# ffmpeg (Debian 12/bookworm's package is recent enough)
sudo apt install -y ffmpeg

# whisper.cpp — only needed if ASR_ENABLED=true
sudo apt install -y cmake
git clone https://github.com/ggml-org/whisper.cpp.git /opt/whisper.cpp
cd /opt/whisper.cpp
cmake -B build && cmake --build build -j --config Release
# binary lands at /opt/whisper.cpp/build/bin/whisper-cli

bash ./models/download-ggml-model.sh base.en
# model lands at /opt/whisper.cpp/models/ggml-base.en.bin
```

</details>

### 2. Deploy the app

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin chmedia
sudo mkdir -p /opt/ch-media-service
sudo chown chmedia:chmedia /opt/ch-media-service

# copy/clone the repo into /opt/ch-media-service, then:
cd /opt/ch-media-service
sudo -u chmedia npm ci --omit=dev
sudo -u chmedia cp .env.example .env
```

Edit `/opt/ch-media-service/.env`:

```bash
PORT=4020
HOST=127.0.0.1                  # loopback only — Caddy is the public entrypoint
MEDIA_SERVICE_TOKEN=$(openssl rand -hex 32)   # generate once, keep it secret

YTDLP_PATH=/usr/local/bin/yt-dlp
FFMPEG_PATH=/usr/bin/ffmpeg
WHISPER_CPP_PATH=/opt/whisper.cpp/build/bin/whisper-cli
WHISPER_MODEL_PATH=/opt/whisper.cpp/models/ggml-base.en.bin
ASR_ENABLED=true
```

### 3. Run it as a systemd service

`/etc/systemd/system/ch-media-service.service`:

```ini
[Unit]
Description=CH Media Service
After=network.target

[Service]
Type=simple
User=chmedia
WorkingDirectory=/opt/ch-media-service
EnvironmentFile=/opt/ch-media-service/.env
ExecStart=/usr/bin/node src/server.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ch-media-service
sudo systemctl status ch-media-service
journalctl -u ch-media-service -f
```

### 4. Reverse proxy with Caddy

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
```

`/etc/caddy/Caddyfile`:

```
media.yourdomain.com {
    reverse_proxy 127.0.0.1:4020
}
```

```bash
sudo systemctl reload caddy
```

Caddy auto-provisions/renews the TLS cert for the domain the first time it serves it.

### 5. Cloudflare (custom domain)

- **DNS**: add an `A` record `media` → the server's public IP, proxy status **Proxied**
  (orange cloud).
- **SSL/TLS mode**: set to **Full (strict)** — Cloudflare then validates Caddy's cert
  instead of trusting any self-signed/plaintext origin.
- **Firewall**: only `80`/`443` need to be open publicly (`sudo ufw allow 80,443/tcp`);
  the app itself stays on `127.0.0.1:4020`, unreachable except through Caddy.
- This service was designed to be reachable only from `CHBackend`/`mi-worker` on a
  private network (see "Why" above). Putting it on a public hostname changes that
  trust model — the `MEDIA_SERVICE_TOKEN` bearer check still gates every request, but
  consider also adding a Cloudflare Access application (Zero Trust) or an IP Access
  Rule that allow-lists `CHBackend`'s outbound IP, so the endpoint isn't reachable by
  anyone who just guesses the domain.

### 6. Point CHBackend at it

```bash
MEDIA_SERVICE_URL=https://media.yourdomain.com
MEDIA_SERVICE_TOKEN=<same token as above>
```
