#!/usr/bin/env bash
# Creates the GitHub release for the SDK and CLI version that packages:publish just published:
# tag v<version> at the release commit, with both packages' changelog sections as the notes.
# Rerunning for a version that already has a release changes nothing.
set -euo pipefail

dist_tag="$1"
: "${RELEASE_COMMIT:?RELEASE_COMMIT must name the published commit}"
: "${GH_REPO:?GH_REPO must name the repository, such as Agentifiers/deployments}"

version="$(jq -er .version packages/sdk/package.json)"
if [[ "$(jq -er .version packages/cli/package.json)" != "${version}" ]]; then
  echo "SDK and CLI versions differ." >&2
  exit 1
fi
tag="v${version}"

if gh release view "${tag}" >/dev/null 2>&1; then
  echo "Release ${tag} already exists."
  exit 0
fi

section() {
  awk -v heading="## ${version}" '$0 == heading { on = 1; next } on && /^## / { exit } on' "$1"
}

notes="$(mktemp)"
trap 'rm -f "${notes}"' EXIT
{
  printf 'Published to npm under the `%s` tag.\n\n' "${dist_tag}"
  printf '```sh\nnpm install @agentifiers/deployments-sdk@%s\nnpm i -g @agentifiers/deployments-cli@%s\n```\n\n' \
    "${version}" "${version}"
  for package in sdk cli; do
    changes="$(section "packages/${package}/CHANGELOG.md")"
    if [[ -z "${changes//[[:space:]]/}" ]]; then
      echo "packages/${package}/CHANGELOG.md has no section for ${version}." >&2
      exit 1
    fi
    printf '## [@agentifiers/deployments-%s](https://www.npmjs.com/package/@agentifiers/deployments-%s/v/%s)\n%s\n\n' \
      "${package}" "${package}" "${version}" "${changes}"
  done
} >"${notes}"

# GitHub refuses release notes over 125,000 characters; link the changelogs instead.
if (($(wc -m <"${notes}") > 125000)); then
  {
    printf 'Published to npm under the `%s` tag. The changes are in the changelogs of ' "${dist_tag}"
    printf '[the SDK](https://github.com/%s/blob/%s/packages/sdk/CHANGELOG.md) and ' "${GH_REPO}" "${tag}"
    printf '[the CLI](https://github.com/%s/blob/%s/packages/cli/CHANGELOG.md).\n' "${GH_REPO}" "${tag}"
  } >"${notes}"
fi

flags=(--target "${RELEASE_COMMIT}" --title "SDK and CLI ${version}" --notes-file "${notes}")
if [[ "${version}" == *-* ]]; then
  flags+=(--prerelease --latest=false)
elif [[ "${dist_tag}" != "latest" ]]; then
  flags+=(--latest=false)
fi
gh release create "${tag}" "${flags[@]}"
