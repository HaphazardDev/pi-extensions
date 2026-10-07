# Changelog

## 0.1.1

### Patch Changes

- ff2166f: Require Node.js 22.19 or newer to match the Pi 1.0 runtime requirement.
- 9154634: Migrate tool schemas from the legacy `@sinclair/typebox` package to Pi's host-provided `typebox` 1.x package.

All notable changes to this package will be documented in this file.

## 0.1.0

### Added

- Explicit background shell job execution.
- Start, list, status, paginated logs, and stop agent tools.
- Session-owned process lifecycle with timeout and process-group cleanup.
- Completion notifications with optional agent wake-up.
- A task-focused, theme-colored above-prompt job widget using Nerd Font's `run all` glyph, plus a full-screen `/ps` job/output browser with bottom-pinned shortcuts and a `Ctrl+Alt+K` shortcut.
- Optional human-readable job labels exposed through tools and the process browser.
- Active-first, newest-first job ordering with live label/command/ID/status filtering.
- Confirmed deletion of one or all completed jobs, including their disk-backed logs.
- Explicit `FOLLOWING` and `PAUSED` output modes with `f`/`G` to resume the live tail.
- Visible log read/write warnings instead of silent output-storage failures.
- Validated configuration for the browser shortcut, widget icon or ASCII fallback, UI completion notifications, and idle completed-job visibility.
- Documentation for `pi-permission-system` shell-tool parity.
