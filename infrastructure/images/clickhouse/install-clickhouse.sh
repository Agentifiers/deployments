#!/usr/bin/env bash
# CLICKHOUSE_PACKAGES lists "<package>=<sha256>" pairs from the module's clickhouse-packages.json.
set -euo pipefail

sudo env DEBIAN_FRONTEND=noninteractive apt-get update
sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl jq nvme-cli unzip xfsprogs
# Ubuntu 24.04 no longer packages the AWS CLI, so install the official v2 bundle.
awscli_directory="$(mktemp -d)"
curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" -o "${awscli_directory}/awscliv2.zip"
unzip -q "${awscli_directory}/awscliv2.zip" -d "${awscli_directory}"
sudo "${awscli_directory}/aws/install"
rm -rf "${awscli_directory}"
aws --version

package_directory="$(mktemp -d)"
for pin in ${CLICKHOUSE_PACKAGES}; do
  package="${pin%%=*}"
  curl -fsSL "https://packages.clickhouse.com/deb/pool/main/c/clickhouse/${package}_${CLICKHOUSE_VERSION}_arm64.deb" \
    -o "${package_directory}/${package}.deb"
  echo "${pin#*=}  ${package_directory}/${package}.deb" | sha256sum --check --strict
done
sudo env DEBIAN_FRONTEND=noninteractive CLICKHOUSE_PASSWORD='' apt-get install -y "${package_directory}"/*.deb
rm -rf "${package_directory}"
sudo systemctl disable clickhouse-server
sudo rm -rf /var/lib/clickhouse/* /var/log/clickhouse-server/*
sudo apt-get clean
sudo rm -rf /var/lib/apt/lists/*

clickhouse-client --version
test -x /usr/bin/clickhouse-server
test -x /usr/bin/clickhouse-client
