# Changesets

Add a changeset for customer- or operator-visible SDK and CLI changes. The two
client packages are versioned together; publishing is performed from their
verified staged packages under `packages/*/dist/package`.

## Versioning

SDK and CLI versions are fixed together in `.changeset/config.json`. Before the
next prerelease changeset, enter the alpha prerelease mode once and commit the
generated `.changeset/pre.json`:

```sh
bun run changeset -- pre enter alpha
```

While prerelease mode remains active, add a changeset for each subsequent
consumer-visible change and run `bun run version:packages`. Keep both source
package versions identical and publish those versions under `next`.

When the packages are ready for a stable release, leave prerelease mode before
versioning and publish the resulting version under `latest`:

```sh
bun run changeset -- pre exit
bun run version:packages
```

## Publishing

`@deployments-ai/sdk` and `@deployments-ai/cli` are public packages on
npmjs.com. Check the staged artifacts locally with:

```sh
bun run packages:build
bun run packages:verify
```

The `Release client packages` workflow (`release-packages.yml`) runs from
`main` in the `npm` environment once CI has passed on the commit. It builds and
verifies the staged packages, then publishes them with npm trusted publishing
and provenance; no npm token is stored. Both fixed-version artifacts are first
published under a release-specific staging tag, and the requested `next` or
`latest` tag moves only after both exist. Prerelease versions cannot go to
`latest`.
