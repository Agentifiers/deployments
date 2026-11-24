# Prototype desktop layer: a virtual X11 desktop that agents drive with Cua Driver.
#
# This file has no FROM. The image publisher appends it to ../Dockerfile and builds the result as
# the `desktop` image variant, so code.execute, file transfer, and the headless browser tools behave
# as they do in the sandbox image:
#
#   bun run sandbox:lambda-microvm:image -- --variant desktop --publish --region us-east-2
#
# Build it locally from apps/sandbox-microvm the same way:
#
#   cat Dockerfile desktop/layer.Dockerfile | docker build --platform linux/arm64 -t sandbox-desktop -f - .
#
# Agents drive the desktop through the existing exec route, for example
# `cua-driver get_desktop_state '{"session":"s1","screenshot_out_file":"/workspace/screen.png"}'`,
# then read the PNG through the file route. start-desktop.sh starts the display, the session and
# accessibility buses, the window manager, and the Cua Driver daemon before the control server.

# Cua Driver (MIT), the published linux-arm64 release, pinned by version and SHA-256. It needs glibc
# 2.31 or later (AL2023 has 2.34) plus libX11, libXi, and libxkbcommon at load time.
ARG CUA_DRIVER_VERSION=0.49.7
ARG CUA_DRIVER_SHA256=f8fb4770acc81cebe6105c0f981950d1850dfcfc0fbc134e7f3497b5a464d034

# Xvfb is the display, metacity the window manager (cua-driver activates and lists windows through
# EWMH), and dbus-daemon plus at-spi2 the accessibility tree. at-spi2-atk bridges GTK 3 apps such
# as Firefox onto it. xterm and Firefox are the desktop's first apps.
RUN dnf install -y \
    at-spi2-atk \
    at-spi2-core \
    dbus-daemon \
    firefox \
    libX11 \
    libXi \
    libXtst \
    libxkbcommon \
    metacity \
    xorg-x11-server-Xvfb \
    xterm \
    && dnf clean all

RUN curl -fsSL --retry 3 -o /tmp/cua-driver.tar.gz \
      "https://github.com/trycua/cua/releases/download/cua-driver-rs-v${CUA_DRIVER_VERSION}/cua-driver-rs-${CUA_DRIVER_VERSION}-linux-arm64.tar.gz" \
    && echo "$CUA_DRIVER_SHA256  /tmp/cua-driver.tar.gz" | sha256sum -c - \
    && mkdir -p /opt/cua-driver \
    && tar --no-same-owner -xzf /tmp/cua-driver.tar.gz -C /opt/cua-driver --strip-components=1 \
    && ln -s /opt/cua-driver/cua-driver /usr/bin/cua-driver \
    && rm -f /tmp/cua-driver.tar.gz \
    && cua-driver --version

# Every exec inherits the control server's environment, so commands reach the display, the session
# bus, and the driver daemon without setup. The sandbox sends no telemetry and checks no updates.
ENV DISPLAY=:99 \
    XDG_RUNTIME_DIR=/run/agent-desktop \
    DBUS_SESSION_BUS_ADDRESS=unix:path=/run/agent-desktop/bus \
    GNOME_ACCESSIBILITY=1 \
    QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1 \
    DO_NOT_TRACK=1 \
    CUA_TELEMETRY=0 \
    CUA_DRIVER_RS_UPDATE_CHECK=false \
    SANDBOX_DESKTOP_GEOMETRY=1280x800x24

COPY desktop/start-desktop.sh /opt/agent-sandbox/start-desktop.sh

CMD ["/bin/bash", "/opt/agent-sandbox/start-desktop.sh"]
