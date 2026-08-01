# @haphazarddev/pi-background-bash

Run explicit background shell jobs from Pi, inspect them through agent tools, and browse their output in Pi's TUI.

> This package is currently under local development and has not been published.

## Design

The extension leaves Pi's built-in `bash` tool unchanged. The agent must deliberately call `background_bash_start`; commands are never moved into the background merely because they run for a long time.

Each job is owned by the current Pi process and records:

- a stable `bg-…` job ID and operating-system PID
- command and working directory
- start/end timestamps and elapsed time
- running, exited, failed, timed-out, or stopped state
- exit code or terminating signal
- disk-backed stdout/stderr logs

Running jobs receive `SIGTERM` during Pi shutdown and are force-killed after a short grace period if necessary. On POSIX systems, signals target the complete process group so child processes do not remain behind.

## Local installation

From this repository:

```bash
npm install
npm run build
pi install ./extensions/pi-background-bash
```

Restart Pi after installing or use `/reload` if the current Pi session supports extension reloads.

To remove the local package:

```bash
pi remove @haphazarddev/pi-background-bash
```

## Agent tools

| Tool | Purpose |
| --- | --- |
| `background_bash_start` | Start a command and return immediately with its job ID and PID |
| `background_bash_list` | List jobs owned by this Pi process |
| `background_bash_status` | Read one job's current state and exit metadata |
| `background_bash_logs` | Read a bounded page of stdout/stderr log lines |
| `background_bash_stop` | Gracefully stop a running job, with optional force escalation |

A start call accepts a command, optional working directory, optional timeout, and an option controlling whether completion wakes the agent. Ordinary commands should continue to use Pi's built-in `bash` tool.

## TUI

An above-prompt widget shows the newest running command, its theme-colored status, and elapsed time:

```text
 npm run build • running 8s • +1 more • /ps
```

The leading glyph is Nerd Font's `cod-run_all` (`U+EB9E`) and is rendered in a neutral, dim color.

When no jobs are running, it shows the most recently completed command with a success, failure, timeout, or stopped color.

Open the browser with:

```text
/ps
```

The browser opens as a focused full-screen process view with a prominent title. Its shortcut bar stays pinned to the bottom while the job list or output fills the available terminal height.

| Key | Action |
| --- | --- |
| `Ctrl+Alt+K` | Open the background process browser from the prompt |
| `↑` / `↓`, `j` / `k` | Navigate jobs or output |
| `Enter` | Open the selected job |
| `Esc`, `q` | Return to the list or close |
| `r` | Reload the displayed output |
| `s` | Stop the selected running job |
| `g` / `G` | Jump to the beginning/end of output |

The browser refreshes when jobs emit output or change state.

## Permission-system parity

`background_bash_start` carries shell semantics. If you use `@gotgenes/pi-permission-system`, add it to `shellTools` so it receives the same Bash command, path, wrapper, and external-directory checks as Pi's native `bash` tool:

```json
{
  "shellTools": {
    "background_bash_start": {
      "commandArgument": "command",
      "workdirArgument": "cwd"
    }
  }
}
```

The global configuration file is normally:

```text
~/.pi/agent/extensions/pi-permission-system/config.json
```

Without this mapping, the permission extension can only treat the start operation as a generic third-party tool; it cannot apply its full Bash policy.

## Logs and ownership

Logs live under a package-owned directory in the operating system's temporary directory. Tool and UI reads are paginated so a large build cannot flood model context or the terminal. Very long or unterminated lines are split into bounded records, each page has a character budget, and sparse byte checkpoints are stored on disk so pagination does not retain one heap offset per output line.

Jobs are **session-owned**, not durable services. Closing Pi stops running jobs and cleans temporary job state. Use tmux for interactive long-lived processes and launchd/systemd for services that should outlive Pi.

The initial package supports macOS and Linux. Windows installation is blocked until equivalent whole-process-tree cleanup is implemented and tested.

## Current scope

The local-testing scaffold intentionally does not include:

- automatic foreground-to-background conversion
- durable jobs that survive Pi
- remote execution
- automatic restarts
- shell history integration

These can be evaluated after the explicit, session-owned workflow has been tested locally.

## Development

```bash
npm test -- extensions/pi-background-bash/test
npm run typecheck
npm run build
npm pack --workspace extensions/pi-background-bash --dry-run
```
