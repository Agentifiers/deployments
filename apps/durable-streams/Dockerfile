# The Go build runs on the builder's own architecture and cross-compiles: under QEMU emulation the
# same compile takes about 20 minutes on an arm64 runner.
# Go 1.27 makes json.RawMessage an alias of jsontext.Value, which the pinned Caddy 2.10.2 no longer
# recognizes as a module map, so the server panics at startup. Stay on Go 1.26 until the plugin
# moves to a Caddy release that supports Go 1.27.
FROM --platform=$BUILDPLATFORM golang:1.26.11-alpine AS build

ARG DURABLE_STREAMS_COMMIT=a172acc389351cb3db6deb5cd60e3dec11e7ff39

RUN apk add --no-cache ca-certificates git
# Fetches the pinned commit alone; a full clone of the upstream history took most of the build.
RUN git init -q /src \
  && git -C /src fetch -q --depth 1 https://github.com/durable-streams/durable-streams.git \
    "${DURABLE_STREAMS_COMMIT}" \
  && git -C /src checkout -q --detach FETCH_HEAD

WORKDIR /src/packages/caddy-plugin
ARG TARGETOS
ARG TARGETARCH
RUN mkdir -p /out \
  && CGO_ENABLED=0 GOOS="$TARGETOS" GOARCH="$TARGETARCH" \
    go build -trimpath -o /out/durable-streams-server ./cmd/caddy

FROM alpine:3.24

RUN apk add --no-cache ca-certificates \
  && addgroup -S durable-streams \
  && adduser -S -G durable-streams durable-streams \
  && mkdir -p /data /etc/durable-streams \
  && chown -R durable-streams:durable-streams /data /etc/durable-streams

COPY --from=build /out/durable-streams-server /usr/local/bin/durable-streams-server
COPY apps/durable-streams/Caddyfile /etc/durable-streams/Caddyfile
COPY apps/durable-streams/docker-entrypoint.sh /usr/local/bin/durable-streams-entrypoint

RUN chmod 0555 /usr/local/bin/durable-streams-entrypoint

EXPOSE 4437
VOLUME ["/data"]

USER durable-streams

ENTRYPOINT ["durable-streams-entrypoint"]
