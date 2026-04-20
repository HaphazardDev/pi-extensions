# HaphazardDev pi extensions

A collection of pi extension packages published to npm and installable directly in pi.

## Install from npm

```bash
pi install npm:@haphazarddev/pi-vim-quit
pi install npm:@haphazarddev/pi-ask-user-question
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

## Install from a local checkout

If you want to test directly from this repository:

```bash
pi install ./extensions/pi-vim-quit
pi install ./extensions/pi-ask-user-question
```

## For maintainers

This repository is an npm workspace monorepo with packages under `extensions/`.

```bash
vp install
vp exec tsc --noEmit
```
