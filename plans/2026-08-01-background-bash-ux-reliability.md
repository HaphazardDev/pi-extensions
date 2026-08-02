# Background Bash UX and Reliability Improvements Implementation Plan

> **For Hermes:** Execute task-by-task with strict test-driven development and independent review before the final commit.

**Goal:** Implement all seven approved improvements while preserving Pi 0.83 compatibility, session-owned process semantics, permission-system parity, and existing model tools.

**Architecture:** Extend `JobInfo` and `StartJobOptions` with optional labels and a surfaced log-error field; add explicit completed-job removal to `JobManager`/`LogStore`; and evolve `BackgroundJobsComponent` into a small state machine for sorted/filtered lists, confirmation, and following/paused output. Load validated user preferences once from `~/.pi/agent/extensions/pi-background-bash/config.json`, with dependency injection for deterministic tests.

**Tech Stack:** TypeScript, Pi extension API/TUI, TypeBox, Node child processes/filesystem, Vitest.

---

### Task 1: Configuration and labels

**Files:**
- Create: `extensions/pi-background-bash/src/config.ts`
- Create: `extensions/pi-background-bash/test/config.test.ts`
- Modify: `extensions/pi-background-bash/src/types.ts`
- Modify: `extensions/pi-background-bash/src/tools.ts`
- Modify: `extensions/pi-background-bash/src/job-manager.ts`
- Test: `extensions/pi-background-bash/test/tools.test.ts`
- Test: `extensions/pi-background-bash/test/job-manager.test.ts`

**Steps:**
1. Write failing tests for default/validated config and malformed-config diagnostics.
2. Verify focused tests fail because config support is absent.
3. Implement config loading via Pi's `getAgentDir()` and `extensions/pi-background-bash/config.json`.
4. Write failing tests for optional start labels in tool results and manager snapshots.
5. Implement trimmed, bounded labels and preserve them through lifecycle snapshots.
6. Run focused tests and commit when green.

### Task 2: Per-job cleanup and log error visibility

**Files:**
- Modify: `extensions/pi-background-bash/src/log-store.ts`
- Modify: `extensions/pi-background-bash/src/job-manager.ts`
- Modify: `extensions/pi-background-bash/src/types.ts`
- Test: `extensions/pi-background-bash/test/log-store.test.ts`
- Test: `extensions/pi-background-bash/test/job-manager.test.ts`

**Steps:**
1. Write failing tests that delete one closed log and retain other logs.
2. Implement `LogStore.remove()` with pending-write completion and file cleanup.
3. Write failing tests for removing one/all completed jobs while refusing running jobs.
4. Implement manager removal APIs and lifecycle notifications.
5. Write failing tests that inject append/close failures and assert `logError` is surfaced.
6. Implement first-error capture without changing process exit status.
7. Run focused tests and commit when green.

### Task 3: Active-first list and completed-job cleanup UI

**Files:**
- Modify: `extensions/pi-background-bash/src/ui.ts`
- Modify: `extensions/pi-background-bash/src/index.ts`
- Test: `extensions/pi-background-bash/test/ui.test.ts`
- Test: `extensions/pi-background-bash/test/index.test.ts`

**Steps:**
1. Write failing UI tests for newest-running-first ordering and initial selection.
2. Implement stable view ordering: running newest-first, then completed newest-first.
3. Write failing tests for `d` and `c` double-press confirmation and running-job protection.
4. Extend the UI data source with removal methods and implement confirmation state/messages.
5. Keep selection anchored by job ID across refreshes.
6. Run focused tests and commit when green.

### Task 4: Search and filter

**Files:**
- Modify: `extensions/pi-background-bash/src/ui.ts`
- Test: `extensions/pi-background-bash/test/ui.test.ts`

**Steps:**
1. Write failing tests for `/` entering filter mode, printable input, backspace, Enter, and Escape.
2. Match case-insensitively against label, command, ID, and textual status.
3. Render the filter query and no-match state without displacing the pinned shortcut bar.
4. Preserve a valid selection when filters change.
5. Run focused tests and commit when green.

### Task 5: Explicit follow mode

**Files:**
- Modify: `extensions/pi-background-bash/src/ui.ts`
- Test: `extensions/pi-background-bash/test/ui.test.ts`

**Steps:**
1. Write failing tests for `FOLLOWING`, scrolling to `PAUSED`, and `f` returning to tail.
2. Make `G` re-enable follow mode rather than pinning the current last page.
3. Keep polling while paused without moving the selected offset.
4. Update output shortcut help and run focused tests.
5. Commit when green.

### Task 6: Configurable preferences integration

**Files:**
- Modify: `extensions/pi-background-bash/src/index.ts`
- Modify: `extensions/pi-background-bash/src/format.ts`
- Test: `extensions/pi-background-bash/test/index.test.ts`
- Test: `extensions/pi-background-bash/test/format.test.ts`

**Steps:**
1. Write failing tests for configurable shortcut, Nerd/ASCII/custom icon, UI completion notification, and latest-completed widget visibility.
2. Register the configured shortcut and render the configured icon/fallback.
3. Respect notification and completed-widget preferences while preserving agent-wake semantics.
4. Notify once when config is malformed and continue safely with defaults.
5. Run focused tests and commit when green.

### Task 7: Documentation and complete verification

**Files:**
- Modify: `extensions/pi-background-bash/README.md`
- Modify: `extensions/pi-background-bash/CHANGELOG.md`
- Modify: `plans/2026-07-27-background-bash-extension.md`

**Steps:**
1. Document labels, sorting, filtering, cleanup confirmations, follow mode, log warnings, and every config field.
2. Run focused extension tests.
3. Run `npm run ci` and `git diff --check`.
4. Dogfood `/ps` in a real Pi 0.83 TUI: verify active-first selection, filter entry/exit, follow/pause, cleanup confirmation, shortcut, and widget.
5. Run independent diff review; fix blocking findings with tests first.
6. Commit locally. Do not push or publish.
