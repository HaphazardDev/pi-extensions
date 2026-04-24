# @haphazarddev/pi-copy-code-block

Copy a code block from the latest assistant message straight to your clipboard.

## Install

```bash
pi install npm:@haphazarddev/pi-copy-code-block
```

Or install from a local checkout:

```bash
pi install ./extensions/pi-copy-code-block
```

## Usage

The extension registers:

- `/copy-code`
- `Ctrl+Alt+C`

Behavior:

- if the latest assistant message has **one** code block, it copies immediately
- if it has **multiple** code blocks, it opens a small picker with a preview of the code being copied
- when code blocks are available, it shows a footer hint like `⎘ 1 code block • Ctrl+Alt+C to copy` or `⎘ 3 code blocks • /copy-code • Ctrl+Alt+C`

You can also target or format blocks directly:

```bash
/copy-code 2
/copy-code first
/copy-code last
/copy-code all
/copy-code fenced 2
/copy-code fenced all
```

Short aliases are supported too:

```bash
/copy-code f
/copy-code l
```

## Notes

- The extension scans the most recent completed assistant messages until it finds code blocks.
- By default it copies the **inner code** from fenced code blocks, not the surrounding triple backticks.
- `fenced` preserves the markdown fences and language when copying.
- `all` copies all code blocks in **latest-to-oldest** order, joined by a configurable separator.
- Code blocks are ordered **latest to oldest**, so the most recently visible block on screen is `1`.
- Multi-line previews in the picker show `⏎ …` to indicate the copied block continues beyond the first line.
- The picker supports `1-9`, arrow keys, Enter, and Escape.

## Config

The extension has a tiny config section at the top of `src/index.ts`:

- `showStatusHint`
- `statusIcon`
- `shortcut`
- `previewWidth`
- `copyAllSeparator`
- `maxAssistantMessagesToScan`

That makes it easy to disable the footer hint entirely, tune the icon and keyboard shortcut, adjust preview truncation, control how `/copy-code all` joins blocks, and change how far back the fallback search looks.

## Repository

- Source: https://github.com/HaphazardDev/pi-extensions
- Issues: https://github.com/HaphazardDev/pi-extensions/issues
