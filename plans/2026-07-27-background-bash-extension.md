# Background Bash Extension Implementation Plan

> **For Hermes:** Use test-driven development to implement this plan task-by-task.

**Goal:** Add an unpublished `@haphazarddev/pi-background-bash` package that runs explicit background shell jobs, exposes their lifecycle to the agent, and provides a navigable Pi TUI for job counts and output.

**Architecture:** A session-scoped `BackgroundJobManager` owns child processes and disk-backed logs. A thin Pi adapter registers one shell-semantic start tool plus read-only lifecycle tools, updates an above-editor widget, injects completion messages, and exposes `/ps` as a custom two-level browser (job list → output detail). Ordinary Pi `bash` remains unchanged; all jobs are session-owned and cleaned up during `session_shutdown`.

**Tech Stack:** TypeScript 7, Node.js `child_process`/`fs`, Pi Coding Agent 0.83.0 extension API, Pi TUI, TypeBox, Vitest.

---

## Product decisions

- Execution is explicit only. There is no automatic foreground-to-background threshold.
- `background_bash_start` is the only shell-executing extension tool. Permission-system users map it through `shellTools` using `command` and `cwd`.
- Job logs are stored outside the repository under the OS temp directory and read with bounded line pagination.
- Jobs use stable `bg-<hex>` IDs; PID is metadata, not identity.
- Jobs are session-owned by default. Pi shutdown sends `SIGTERM`, waits briefly, then escalates to `SIGKILL`.
- POSIX uses detached process groups and negative-PID signals. Windows uses task termination fallback and is kept behind injected platform/process adapters for testing.
- Completion records include exit code or signal, elapsed time, timestamps, command, cwd, and timeout/stop outcome.
- Completion messages wake the agent as a follow-up only when requested by the start call; UI notifications and the above-editor widget always update.
- The above-editor widget uses Nerd Font's dim `run all` glyph and shows the newest running command with a theme-colored status and elapsed time, e.g. ` npm run build • running 8s • +1 more • /ps`; when idle, it shows the latest completed command and outcome.
- `/ps` or `Ctrl+Alt+K` opens a focused full-screen, keyboard-navigable process view with bottom-pinned shortcuts. Enter opens output; up/down or j/k navigate; s stops a running job; q/Escape returns or closes. The output view also exposes `r` to reload logs.

## Acceptance criteria

1. A background command returns immediately with job ID, PID, cwd, and log location.
2. Status transitions are observable: `running` → `exited`, `failed`, `timed_out`, or `stopped`.
3. Logs preserve stdout/stderr and support bounded offset/limit pagination.
4. Stopping a job targets its process group and is idempotent.
5. A timeout records `timed_out` distinctly from user stop.
6. Session shutdown cleans up running jobs and clears UI status.
7. Tools exist for start, list, status, logs, and stop.
8. The start tool documents the required `pi-permission-system.shellTools` mapping.
9. Job completion can inject a structured follow-up result and updates Pi status/notifications.
10. The TUI supports list and detail navigation and renders current output.
11. The package builds, typechecks, tests, and packs without publishing.

---

### Task 1: Package scaffold and public types

**Files:**
- Create: `extensions/pi-background-bash/package.json`
- Create: `extensions/pi-background-bash/tsconfig.build.json`
- Create: `extensions/pi-background-bash/LICENSE`
- Create: `extensions/pi-background-bash/src/types.ts`
- Create: `extensions/pi-background-bash/test/types.test.ts`
- Modify: `package.json`

**Steps:**
1. Write a failing import/shape test for job statuses and snapshots.
2. Run `npm test -- extensions/pi-background-bash/test/types.test.ts` and verify RED.
3. Add package metadata and minimal public types.
4. Run the focused test and verify GREEN.

### Task 2: Disk-backed log store

**Files:**
- Create: `extensions/pi-background-bash/src/log-store.ts`
- Create: `extensions/pi-background-bash/test/log-store.test.ts`

**Steps:**
1. Write failing tests for append/read pagination, empty logs, line offsets, and cleanup.
2. Verify RED.
3. Implement `JobLogStore` using a per-session temporary directory and bounded reads.
4. Verify focused tests GREEN.

### Task 3: Background job lifecycle

**Files:**
- Create: `extensions/pi-background-bash/src/job-manager.ts`
- Create: `extensions/pi-background-bash/test/job-manager.test.ts`

**Steps:**
1. Write failing tests using real short Node subprocesses for immediate return, output capture, exit metadata, timeout, stop, and shutdown cleanup.
2. Verify each behavior fails before implementation.
3. Implement the minimum lifecycle manager with dependency-injected clock/platform where necessary.
4. Verify focused tests and then all extension tests GREEN.

### Task 4: Agent tools and completion delivery

**Files:**
- Create: `extensions/pi-background-bash/src/tools.ts`
- Create: `extensions/pi-background-bash/test/tools.test.ts`

**Steps:**
1. Write failing registration and execution tests for `background_bash_start`, `_list`, `_status`, `_logs`, and `_stop`.
2. Verify RED.
3. Register TypeBox schemas and compact structured results.
4. Add completion callback behavior with optional `notifyAgent`, `pi.sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })`, UI notification, and status refresh.
5. Verify focused and full tests GREEN.

### Task 5: Status and navigable TUI

**Files:**
- Create: `extensions/pi-background-bash/src/format.ts`
- Create: `extensions/pi-background-bash/src/ui.ts`
- Create: `extensions/pi-background-bash/test/format.test.ts`
- Create: `extensions/pi-background-bash/test/ui.test.ts`

**Steps:**
1. Write failing pure rendering tests for empty, running, completed, long-command, and paginated-output states.
2. Write failing input tests using raw terminal sequences for arrows, Enter, Escape, j/k, r, and s.
3. Verify RED.
4. Implement the list/detail component and `/ps` command loop.
5. Update the above-editor widget with `ctx.ui.setWidget` after every lifecycle event.
6. Verify focused and full tests GREEN.

### Task 6: Extension entry point and shutdown

**Files:**
- Create: `extensions/pi-background-bash/src/index.ts`
- Create: `extensions/pi-background-bash/test/index.test.ts`

**Steps:**
1. Write failing tests for session initialization, command registration, status refresh, and shutdown cleanup.
2. Verify RED.
3. Wire manager, tools, UI, events, and command registration.
4. Verify focused and full tests GREEN.

### Task 7: Documentation and local-test workflow

**Files:**
- Create: `extensions/pi-background-bash/README.md`
- Create: `extensions/pi-background-bash/CHANGELOG.md`
- Modify: `README.md`
- Modify: `package.json`

**Steps:**
1. Document local install: `pi install ./extensions/pi-background-bash`.
2. Document `/ps`, tool contracts, keybindings, process ownership, log retention, and platform limits.
3. Document permission parity configuration:

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

4. Add package build/pack scripts and root package listing.

### Task 8: Verification

**Commands:**

```bash
npm run typecheck
npm test
npm run build
npm run pack:all
npm run ci
```

Then inspect the complete diff, run a static security scan, request an independent code review, address blocking findings, and commit the verified branch without publishing or pushing.
