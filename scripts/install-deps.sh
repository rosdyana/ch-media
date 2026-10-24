#!/usr/bin/env bash
#
# Installs the system-level dependencies for CH Media Service on a Debian server:
#   - Node.js (NodeSource)
#   - yt-dlp  (standalone binary in /usr/local/bin)
#   - ffmpeg  (apt)
#   - whisper.cpp + a ggml model, only with --with-asr (needed for ASR_ENABLED=true)
#
# Safe to re-run: each step skips or upgrades in place instead of failing.
#
# Usage:
#   sudo ./scripts/install-deps.sh [--with-asr] [--model NAME] [--whisper-dir PATH] [--node-major N]
#
# Examples:
#   sudo ./scripts/install-deps.sh
#   sudo ./scripts/install-deps.sh --with-asr --model small.en
#
set -euo pipefail

# ── Defaults ───────────────────────────────────────────────────────────────
NODE_MAJOR=20
WITH_ASR=0
WHISPER_MODEL=large-v3-turbo
WHISPER_DIR=/opt/whisper.cpp

# ── Args ───────────────────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --with-asr) WITH_ASR=1; shift ;;
    --model) WHISPER_MODEL="$2"; shift 2 ;;
    --whisper-dir) WHISPER_DIR="$2"; shift 2 ;;
    --node-major) NODE_MAJOR="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root (e.g. sudo $0 $*)" >&2
  exit 1
fi

log() { echo -e "\n==> $*"; }

# ── 1. Base packages ────────────────────────────────────────────────────────
log "Installing base packages"
apt-get update -y
apt-get install -y curl git ca-certificates build-essential python3

# ── 2. Node.js ───────────────────────────────────────────────────────────────
CURRENT_NODE_MAJOR=0
if command -v node >/dev/null 2>&1; then
  CURRENT_NODE_MAJOR="$(node -v | sed -E 's/^v([0-9]+).*/\1/')"
fi

if [ "$CURRENT_NODE_MAJOR" -lt "$NODE_MAJOR" ]; then
  log "Installing Node.js ${NODE_MAJOR}.x (found: $(command -v node >/dev/null 2>&1 && node -v || echo none))"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
else
  log "Node.js already satisfies >= ${NODE_MAJOR} ($(node -v)), skipping"
fi

# ── 3. yt-dlp ────────────────────────────────────────────────────────────────
log "Installing/updating yt-dlp"
curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
chmod a+rx /usr/local/bin/yt-dlp
/usr/local/bin/yt-dlp --version

# ── 4. ffmpeg ────────────────────────────────────────────────────────────────
log "Installing ffmpeg"
apt-get install -y ffmpeg
ffmpeg -version | head -n1

# ── 5. whisper.cpp (optional, for ASR_ENABLED=true) ─────────────────────────
if [ "$WITH_ASR" -eq 1 ]; then
  log "Installing whisper.cpp into ${WHISPER_DIR}"
  apt-get install -y cmake

  if [ -d "${WHISPER_DIR}/.git" ]; then
    git -C "${WHISPER_DIR}" pull --ff-only
  else
    git clone https://github.com/ggml-org/whisper.cpp.git "${WHISPER_DIR}"
  fi

  # Portable baseline rather than whisper.cpp's default -march=native: a GCP E2 VM can
  # land on a different CPU platform after a stop/start, and a native build then dies
  # with SIGILL. Same flags as the Dockerfile's WHISPER_CMAKE_FLAGS.
  cmake -B "${WHISPER_DIR}/build" -S "${WHISPER_DIR}" \
    -DGGML_NATIVE=OFF -DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON
  cmake --build "${WHISPER_DIR}/build" -j"$(nproc)" --config Release

  MODEL_FILE="${WHISPER_DIR}/models/ggml-${WHISPER_MODEL}.bin"
  if [ ! -f "$MODEL_FILE" ]; then
    log "Downloading whisper model: ${WHISPER_MODEL}"
    bash "${WHISPER_DIR}/models/download-ggml-model.sh" "${WHISPER_MODEL}"
  else
    log "Whisper model already present: ${MODEL_FILE}"
  fi

  WHISPER_BIN="${WHISPER_DIR}/build/bin/whisper-cli"
else
  log "Skipping whisper.cpp (pass --with-asr to install it)"
  WHISPER_BIN=""
  MODEL_FILE=""
fi

# ── Summary ──────────────────────────────────────────────────────────────────
log "Done. Suggested .env values:"
echo "YTDLP_PATH=/usr/local/bin/yt-dlp"
echo "FFMPEG_PATH=$(command -v ffmpeg)"
if [ "$WITH_ASR" -eq 1 ]; then
  echo "WHISPER_CPP_PATH=${WHISPER_BIN}"
  echo "WHISPER_MODEL_PATH=${MODEL_FILE}"
  echo "ASR_ENABLED=true"
else
  echo "ASR_ENABLED=false"
fi
