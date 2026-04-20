# Changesets guide

This repo uses [Changesets](https://github.com/changesets/changesets) for versioning and npm publishing.

## When to add a changeset

Add a changeset for any user-facing change to a publishable package in `extensions/`, including:

- new features
- bug fixes
- behavior changes
- package renames or metadata changes that matter to consumers

You usually do **not** need a changeset for:

- repo-only docs
- CI-only changes
- internal refactors with no consumer impact

## Common commands

```bash
vp run changeset
vp run version-packages
vp run release:status
```

## Typical workflow

### Initial publish

For the first release of a new package, publish its existing version without adding a changeset. In this repo, that means the initial `0.1.0` release can publish directly from `main` if the package has not been published before.

### Ongoing releases

1. Make your package changes.
2. Run `vp run changeset` and describe the consumer-facing change.
3. Commit the code and the new markdown file in `.changeset/`.
4. Merge to `main`.
5. The release workflow will open or update a release PR.
6. Merging that release PR publishes updated packages to npm.

## Notes

- Packages in this repo are published publicly under the `@haphazarddev/*` scope.
- Prefer npm trusted publishing with GitHub Actions OIDC.
- If trusted publishing is not configured, provide an `NPM_TOKEN` GitHub Actions secret instead.
- The release workflow uses `.changeset/config.json` with `baseBranch: "main"`.
