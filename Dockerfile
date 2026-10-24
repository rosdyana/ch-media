# syntax=docker/dockerfile:1

# Model baked into the image at build time — override with
# `docker build --build-arg WHISPER_MODEL=base.en .` for a smaller/faster build.
ARG WHISPER_MODEL=large-v3-turbo
ARG NODE_IMAGE=node:20-bookworm-slim
# whisper.cpp defaults to GGML_NATIVE=ON, i.e. -march=native for whatever CPU runs
# the build. The image is built on GitHub Actions runners (AVX-512) and run on other
# hosts, where those instructions crash whisper-cli with SIGILL. Target a portable
# x86-64 baseline instead: AVX2/FMA/F16C exist on every x86 platform GCP offers.
# Override for a known host, e.g. --build-arg WHISPER_CMAKE_FLAGS="-DGGML_NATIVE=ON".
ARG WHISPER_CMAKE_FLAGS="-DGGML_NATIVE=OFF -DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON"

# ── whisper.cpp (built from source, statically linked) ─────────────────────────
FROM ${NODE_IMAGE} AS whisper-builder
ARG WHISPER_MODEL
ARG WHISPER_CMAKE_FLAGS
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential cmake git ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git /opt/whisper.cpp
WORKDIR /opt/whisper.cpp
# BUILD_SHARED_LIBS=OFF keeps whisper-cli self-contained so the runtime stage
# only needs to copy the one binary (no libwhisper.so/libggml*.so to chase).
RUN cmake -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF ${WHISPER_CMAKE_FLAGS} \
    && cmake --build build -j"$(nproc)" --config Release
RUN bash ./models/download-ggml-model.sh "${WHISPER_MODEL}"

# ── node_modules (production only) ──────────────────────────────────────────────
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ── runtime ──────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime
ARG WHISPER_MODEL

# libgomp1: whisper.cpp's OpenMP threading runtime (still a dynamic dep even
# with BUILD_SHARED_LIBS=OFF). tini: reaps the yt-dlp/ffmpeg/whisper-cli
# child processes this app spawns and forwards SIGTERM properly as PID 1.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg curl ca-certificates libgomp1 tini \
    && rm -rf /var/lib/apt/lists/*

# yt-dlp_linux (not the plain "yt-dlp" asset — that one's a Python zipapp that
# shells out to a system `python3`, which this image doesn't have) is the
# standalone PyInstaller build with its own bundled interpreter, no deps.
RUN curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && /usr/local/bin/yt-dlp --version

COPY --from=whisper-builder /opt/whisper.cpp/build/bin/whisper-cli /usr/local/bin/whisper-cli
RUN mkdir -p /opt/whisper-models
COPY --from=whisper-builder /opt/whisper.cpp/models/ggml-${WHISPER_MODEL}.bin /opt/whisper-models/ggml-${WHISPER_MODEL}.bin

ENV NODE_ENV=production \
    YTDLP_PATH=/usr/local/bin/yt-dlp \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    WHISPER_CPP_PATH=/usr/local/bin/whisper-cli \
    WHISPER_MODEL_PATH=/opt/whisper-models/ggml-${WHISPER_MODEL}.bin \
    ASR_ENABLED=true \
    HOST=0.0.0.0

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

RUN useradd --system --create-home --shell /usr/sbin/nologin chmedia \
    && chown -R chmedia:chmedia /app
USER chmedia

EXPOSE 4020
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.js"]
