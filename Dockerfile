# ==============================================================================
# AnyTLS Manager Panel - Railway Optimized Dockerfile
# Production-ready multi-arch container with pre-installed anytls-server
# ==============================================================================

FROM node:20-bookworm-slim

# Install system utilities needed by AnyTLS supervisor and network tooling
RUN apt-get update -y && \
    apt-get install -y --no-install-recommends \
      curl \
      wget \
      tar \
      unzip \
      procps \
      psmisc \
      net-tools \
      ca-certificates \
      iproute2 && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Download and install the official anytls-server binary for host architecture
ARG TARGETARCH
RUN mkdir -p /usr/local/bin /app/bin && \
    ARCH="$(uname -m)" && \
    case "$ARCH" in \
      x86_64|amd64) ANYTLS_ARCH="amd64" ;; \
      aarch64|arm64) ANYTLS_ARCH="arm64" ;; \
      *) ANYTLS_ARCH="amd64" ;; \
    esac && \
    RELEASE_VER="0.0.13" && \
    DOWNLOAD_URL="https://github.com/anytls/anytls-go/releases/download/v${RELEASE_VER}/anytls_${RELEASE_VER}_linux_${ANYTLS_ARCH}.zip" && \
    echo "Downloading AnyTLS v${RELEASE_VER} for linux/${ANYTLS_ARCH} from ${DOWNLOAD_URL}..." && \
    curl -fsSL "${DOWNLOAD_URL}" -o /tmp/anytls.zip && \
    unzip -q /tmp/anytls.zip -d /tmp/anytls-bin && \
    mv /tmp/anytls-bin/anytls-server /usr/local/bin/anytls-server && \
    cp /usr/local/bin/anytls-server /app/bin/anytls-server && \
    chmod 755 /usr/local/bin/anytls-server /app/bin/anytls-server && \
    rm -rf /tmp/anytls* && \
    /usr/local/bin/anytls-server -h 2>&1 | head -n 3

# Copy package descriptors and install npm dependencies
COPY package*.json ./
RUN npm install

# Copy application source code
COPY . .

# Build Vite frontend & compile server bundle
RUN npm run build

# Ensure data directory exists and declare persistent volume
RUN mkdir -p /app/data && chmod 777 /app/data
VOLUME ["/app/data"]

# Default Railway variables
ENV NODE_ENV=production
ENV STANDALONE_PANEL=true
ENV PORT=3000
ENV ANYTLS_PORT=8080
ENV DATA_DIR=/app/data

# Expose Web Panel HTTP port (3000) and internal AnyTLS TCP port (8080)
EXPOSE 3000
EXPOSE 8080

# Start the bundled server
CMD ["npm", "start"]
