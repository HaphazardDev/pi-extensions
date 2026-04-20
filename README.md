# HaphazardDev pi extensions

A collection of pi extension packages published to npm and installable directly in pi.

## Install from npm

```bash
pi install npm:@haphazarddev/pi-vim-quit
pi install npm:@haphazarddev/pi-ask-user-question
pi install npm:@haphazarddev/pi-copy-code-block
```

## Packages

### `@haphazarddev/pi-vim-quit`

Quit pi with Vim-style commands typed as normal input:

- `:q`
- `:qa`
- `:wq`

Install:

```bash
pi install npm:@haphazarddev/pi-vim-quit
```

Package docs:
- [`extensions/pi-vim-quit/README.md`](./extensions/pi-vim-quit/README.md)

### `@haphazarddev/pi-ask-user-question`

Adds an `ask_user_question` tool so pi can ask you for clarification, confirmation, selections, and free-form input through the UI.

Install:

```bash
pi install npm:@haphazarddev/pi-ask-user-question
```

Package docs:
- [`extensions/pi-ask-user-question/README.md`](./extensions/pi-ask-user-question/README.md)

### `@haphazarddev/pi-copy-code-block`

Copy a code block from the latest assistant message to your clipboard with `/copy-code` or `Ctrl+Alt+C`.

Install:

```bash
pi install npm:@haphazarddev/pi-copy-code-block
```

Package docs:
- [`extensions/pi-copy-code-block/README.md`](./extensions/pi-copy-code-block/README.md)

## Install from a local checkout

If you want to test directly from this repository:

```bash
pi install ./extensions/pi-vim-quit
pi install ./extensions/pi-ask-user-question
pi install ./extensions/pi-copy-code-block
```

## For maintainers

This repository is an npm workspace monorepo with packages under `extensions/`.

### Local commands

```bash
vp install
vp run typecheck
vp run changeset
vp run release:status
```

### Release workflow

This repo uses Changesets for automated npm releases.

#### Initial publish

For the very first release of a package, keep the package at its existing version (currently `0.1.0`) and publish it without a changeset. On `main`, the workflow will attempt to publish any unpublished packages at their current version.

#### Ongoing releases

1. Add a changeset for consumer-facing package changes with `vp run changeset`.
2. Merge to `main`.
3. GitHub Actions opens or updates a release PR.
4. Merging the release PR publishes updated `@haphazarddev/*` packages to npm.

#### Publishing auth

Prefer npm trusted publishing with GitHub Actions OIDC. This workflow already includes `id-token: write` for that setup.

If you are not using trusted publishing yet, you can instead provide an `NPM_TOKEN` GitHub Actions secret.

The workflow is defined in `.github/workflows/release.yml`.
