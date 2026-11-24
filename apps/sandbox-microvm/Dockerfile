FROM public.ecr.aws/lambda/microvms:al2023-minimal

# Headless Chromium for browser tools: @sparticuz/chromium arm64 pack, pinned by version and SHA-256.
ARG CHROMIUM_PACK_URL=https://github.com/Sparticuz/chromium/releases/download/v153.0.0/chromium-v153.0.0-pack.arm64.tar
ARG CHROMIUM_PACK_SHA256=b6874fc0d7af15e16a15ef1b73177731f698c296c73d26aa4a90840c0777a338

# Node 26 runs the TypeScript browser driver and code.execute JavaScript. AL2023 packages stop at
# nodejs24, so the official linux-arm64 build is pinned by version and SHA-256 (SHASUMS256.txt of the
# release) and linked into /usr/bin.
ARG NODE_URL=https://nodejs.org/dist/v26.12.1/node-v26.12.1-linux-arm64.tar.gz
ARG NODE_SHA256=a6c01af459dd8972ab3fb08ee5da81244d26ba8c4944a62d5bbba8c597ae154f

# libatomic is the one shared library the official Node build needs beyond the base image. nss
# provides libnss3/libnspr4 for Chromium; fontconfig plus Latin, CJK, and emoji fonts render real
# pages.
RUN dnf install -y \
    bash \
    brotli \
    ca-certificates \
    dejavu-sans-fonts \
    dejavu-sans-mono-fonts \
    dejavu-serif-fonts \
    findutils \
    fontconfig \
    git \
    google-noto-emoji-color-fonts \
    google-noto-sans-cjk-ttc-fonts \
    gzip \
    liberation-mono-fonts \
    liberation-sans-fonts \
    liberation-serif-fonts \
    libatomic \
    nss \
    procps-ng \
    python3 \
    tar \
    unzip \
    && dnf clean all \
    && fc-cache -f

RUN curl -fsSL --retry 3 -o /tmp/node.tar.gz "$NODE_URL" \
    && echo "$NODE_SHA256  /tmp/node.tar.gz" | sha256sum -c - \
    && mkdir -p /opt/node \
    && tar --no-same-owner -xzf /tmp/node.tar.gz -C /opt/node --strip-components=1 \
    && ln -s /opt/node/bin/node /usr/bin/node \
    && ln -s /opt/node/bin/npm /usr/bin/npm \
    && rm -f /tmp/node.tar.gz \
    && node --version

# Pre-extract the pack so every browser job launches /opt/agent-sandbox/chromium/chromium directly.
# SwiftShader libraries sit beside the binary, where Chromium loads them; system nss and fonts replace
# the pack's al2023 libraries and fonts.
RUN mkdir -p /opt/agent-sandbox/chromium \
    && curl -fsSL --retry 3 -o /tmp/chromium-pack.tar "$CHROMIUM_PACK_URL" \
    && echo "$CHROMIUM_PACK_SHA256  /tmp/chromium-pack.tar" | sha256sum -c - \
    && tar --no-same-owner -xf /tmp/chromium-pack.tar -C /tmp chromium.br swiftshader.tar.br \
    && brotli -d -o /opt/agent-sandbox/chromium/chromium /tmp/chromium.br \
    && brotli -dc /tmp/swiftshader.tar.br | tar --no-same-owner -x -C /opt/agent-sandbox/chromium \
    && chmod 0755 /opt/agent-sandbox/chromium/chromium \
    && rm -f /tmp/chromium-pack.tar /tmp/chromium.br /tmp/swiftshader.tar.br

WORKDIR /opt/agent-sandbox/browser

COPY browser/package.json browser/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

COPY browser/driver.ts browser/browser-jobs.ts browser/chromium-page.ts browser/egress-proxy.ts browser/job-rules.ts ./

WORKDIR /workspace

COPY control_server.py /opt/agent-sandbox/control_server.py

EXPOSE 8080

CMD ["python3", "/opt/agent-sandbox/control_server.py"]
