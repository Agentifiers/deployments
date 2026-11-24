# syntax=docker/dockerfile:1

FROM oven/bun:1.4.4-slim AS bun

FROM node:26.12.1-trixie-slim AS base
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git unzip zip \
  && rm -rf /var/lib/apt/lists/*

FROM base AS tools
ARG TARGETARCH
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /tmp/tools
# Checksums from the tofu_1.13.2_SHA256SUMS whose .gpgsig verified against OpenTofu key E3E6E43D84CB852EADB0051D0C0AF313E5FD9F80.
RUN <<'EOF'
set -eu
case "$TARGETARCH" in
  amd64) sha256=723bebb0df8411daff1e5fc3862e28ff5581fe5634087f4c29a9aa41d78208b5 ;;
  arm64) sha256=6e815c58a09ee957de606ff48cefad082942e70afc43b737ff975654c54ec453 ;;
  *) echo "unsupported TARGETARCH $TARGETARCH" >&2; exit 1 ;;
esac
curl -fsSLo tofu.zip "https://github.com/opentofu/opentofu/releases/download/v1.13.2/tofu_1.13.2_linux_$TARGETARCH.zip"
echo "$sha256  tofu.zip" | sha256sum -c -
unzip -q tofu.zip tofu -d /usr/local/bin
tofu version
EOF
# Checksums of the 2.37.11 installers whose .sig verified against AWS CLI key FB5DB77FD5C118B80511ADA8A6310ACC4672475C.
RUN <<'EOF'
set -eu
case "$TARGETARCH" in
  amd64) arch=x86_64 sha256=41e1cf5e301ed04ece2ca3c2d8bdf6c3584e8b67292269689cc3e80f97de71ea ;;
  arm64) arch=aarch64 sha256=759f4c75c832c171ce1401a956c5b6c9fe932c311e36786344641bd76adaf08a ;;
  *) echo "unsupported TARGETARCH $TARGETARCH" >&2; exit 1 ;;
esac
curl -fsSLo awscli.zip "https://awscli.amazonaws.com/awscli-exe-linux-$arch-2.37.11.zip"
echo "$sha256  awscli.zip" | sha256sum -c -
unzip -q awscli.zip
./aws/install --install-dir /usr/local/aws-cli --bin-dir /usr/local/bin
EOF
# Checksums from checksums.txt of the go-containerregistry v0.22.1 release.
RUN <<'EOF'
set -eu
case "$TARGETARCH" in
  amd64) arch=x86_64 sha256=0ab7a1d6932a213aed964ce97666c3077fe691c8606413674a8b3e0b9ec4cda0 ;;
  arm64) arch=arm64 sha256=898c0cff975f898a33e8c4580bdafb0e7c02c7faa33374e946762f97c4ab7110 ;;
  *) echo "unsupported TARGETARCH $TARGETARCH" >&2; exit 1 ;;
esac
curl -fsSLo crane.tar.gz "https://github.com/google/go-containerregistry/releases/download/v0.22.1/go-containerregistry_Linux_$arch.tar.gz"
echo "$sha256  crane.tar.gz" | sha256sum -c -
tar -xzf crane.tar.gz -C /usr/local/bin crane
EOF

FROM tools AS providers
ARG TARGETARCH
COPY infrastructure /src/infrastructure
# `providers mirror` refuses a configuration whose modules are not installed, even local ones.
RUN <<'EOF'
set -eu
for root in $(find /src/infrastructure -path /src/infrastructure/modules -prune -o -name .terraform.lock.hcl -exec dirname {} \;); do
  export TF_DATA_DIR="$(mktemp -d)"
  tofu -chdir="$root" get
  tofu -chdir="$root" providers mirror -platform="linux_$TARGETARCH" /opt/tofu/providers
done
EOF

FROM base
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=tools /usr/local/bin/crane /usr/local/bin/crane
COPY --from=tools /usr/local/bin/tofu /usr/local/bin/tofu
COPY --from=tools /usr/local/aws-cli /usr/local/aws-cli
RUN ln -s /usr/local/aws-cli/v2/current/bin/aws /usr/local/bin/aws

WORKDIR /opt/platform
COPY --parents package.json bun.lock apps/*/package.json apps/sandbox-microvm/browser/package.json functions/*/package.json packages/*/package.json ./
RUN bun install --frozen-lockfile --ignore-scripts

COPY --from=providers /opt/tofu/providers /opt/tofu/providers
COPY <<'EOF' /opt/tofu/tofu.rc
provider_installation {
  filesystem_mirror {
    path = "/opt/tofu/providers"
  }
}
EOF
ENV TF_CLI_CONFIG_FILE=/opt/tofu/tofu.rc

COPY . .
RUN --network=none <<'EOF'
set -eu
roots=$(find infrastructure -path infrastructure/modules -prune -o -name .terraform.lock.hcl -exec dirname {} \;)
test -n "$roots"
for root in $roots; do
  data=$(mktemp -d)
  TF_DATA_DIR="$data" tofu -chdir="$root" init -backend=false -input=false -lockfile=readonly -no-color
  rm -rf "$data"
done
EOF

ARG PLATFORM_SOURCE_COMMIT
RUN printf '%s' "$PLATFORM_SOURCE_COMMIT" | grep -Eqx '[0-9a-f]{40}' \
  || { echo "PLATFORM_SOURCE_COMMIT must be a 40-character lowercase hex commit" >&2; exit 1; }
ENV PLATFORM_SOURCE_COMMIT=$PLATFORM_SOURCE_COMMIT

WORKDIR /work
ENTRYPOINT ["bun", "/opt/platform/scripts/deploy-platform.ts"]
CMD ["help"]
