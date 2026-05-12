# Testing improvement plan

## Goal

Add a small, useful Vitest test suite for every extension so that the core behaviors are protected by `npm run ci` / GitHub Actions before making future changes.

## Current state

- [x] Root `package.json` already has the right CI path:
  - [x] `npm run test` runs `vitest run`.
  - [x] `npm run ci` runs typecheck, tests, and package dry-runs.
  - [x] `.github/workflows/ci.yml` runs `vp run ci`.
- [x] `extensions/pi-interactive-code-review` already has unit tests under `test/`.
- [x] These extensions currently need tests:
  - [x] `extensions/pi-vim-quit`
  - [x] `extensions/pi-ask-user-question`
  - [x] `extensions/pi-copy-code-block`

## Principles

- [x] Prefer fast unit tests around pure logic and extension registration behavior.
- [x] Add only enough integration-style mocking to verify that each extension wires into pi correctly.
- [x] Keep tests deterministic: mock clipboard, UI methods, and session state.
- [x] Avoid testing pi internals; test the extension's contract with the pi API.
- [x] When useful, export small pure helpers from `src/index.ts` rather than reaching into private implementation details.

## Step 1: Add a shared test helper for fake pi APIs

- [x] Create `extensions/test-utils/pi.ts` or `test/helpers/pi.ts` with minimal mocks used by multiple extensions.
- [x] Add `createMockPi()` that records calls to:
  - [x] `on(event, handler)`
  - [x] `registerTool(tool)`
  - [x] `registerCommand(name, command)`
  - [x] `registerShortcut(shortcut, shortcut)`
- [x] Add `createMockUi()` with spies for:
  - [x] `notify`
  - [x] `confirm`
  - [x] `input`
  - [x] `editor`
  - [x] `custom`
  - [x] `setStatus`
  - [x] `theme.fg`
- [x] Add `createMockContext()` that can be configured with:
  - [x] `hasUI`
  - [x] `ui`
  - [x] `shutdown`
  - [x] `sessionManager.getBranch()`
- [x] Keep these helpers deliberately small and typed loosely where necessary so tests do not become coupled to all pi API details.

## Step 2: Add tests for `pi-vim-quit`

- [x] Create `extensions/pi-vim-quit/test/index.test.ts`.
- [x] Test that it registers an `input` event handler.
- [x] Test `:q`, `:qa`, and `:wq` from a normal user input source:
  - [x] returns `{ action: "handled" }`
  - [x] calls `ctx.ui.notify("Quitting pi…", "info")`
  - [x] calls `ctx.shutdown()`
- [x] Test non-quit input:
  - [x] returns `{ action: "continue" }`
  - [x] does not notify
  - [x] does not call shutdown
- [x] Test input with `event.source === "extension"`:
  - [x] returns `{ action: "continue" }`
  - [x] does not call shutdown, even if the text is `:q`

This gives high confidence for the entire extension because its behavior is intentionally tiny.

## Step 3: Add tests for `pi-ask-user-question`

- [x] Create `extensions/pi-ask-user-question/test/index.test.ts`.
- [x] Test that it registers the `ask_user_question` tool with the expected name and basic metadata.
- [x] Test no UI available:
  - [x] execute with `ctx.hasUI = false`
  - [x] returns an error text response
  - [x] returns details with `cancelled: true`, `answer: null`, and `mode: "input"`
- [x] Test confirm mode:
  - [x] when `ctx.ui.confirm` resolves `true`, returns `User confirmed: yes` and details answer `"yes"`
  - [x] when it resolves `false`, returns `User answered: no` and details answer `"no"`
- [x] Test free-form input mode:
  - [x] trims a non-empty answer and records `mode: "input"`
  - [x] treats empty/whitespace answers as cancelled
- [x] Test editor mode:
  - [x] uses `ctx.ui.editor` when `multiline` is true or `initialValue` is provided
  - [x] trims a non-empty answer and records `mode: "editor"`
- [x] Test options mode:
  - [x] uses `ctx.ui.custom` to choose an option
  - [x] records `mode: "select"` and the selected answer
  - [x] returns cancelled details when the custom picker returns `null`
- [x] Test custom option flow:
  - [x] when `allowCustomAnswer` is not false and the custom label is selected, prompts for input/editor
  - [x] when `allowCustomAnswer: false`, does not include the custom answer option

Implementation note: `ctx.ui.custom` can call the component and simulate selecting by either invoking the returned `handleInput` with a numeric key / enter, or more simply by capturing the `done` callback and calling it with the desired choice.

## Step 4: Add tests for `pi-copy-code-block` pure behavior

- [x] Create `extensions/pi-copy-code-block/test/index.test.ts`, or split into focused files such as `parse.test.ts` and `command.test.ts`.
- [x] Refactor `src/index.ts` to export these helpers for direct unit tests:
  - [x] `extractCodeBlocks`
  - [x] `parseCopyRequest`
  - [x] `resolveRequestedBlock`
  - [x] `formatSingleBlockForClipboard`
  - [x] `formatAllBlocksForClipboard`
- [x] Test code block extraction:
  - [x] extracts fenced Markdown blocks and languages
  - [x] normalizes CRLF to LF
  - [x] removes the structural newline before the closing fence
  - [x] returns blocks in the order shown by the picker/selector, including correct indexes
  - [x] ignores text without fenced code blocks
- [x] Test request parsing:
  - [x] empty input means single block, unfenced
  - [x] numeric selector, `first`, `last`, `all`
  - [x] `fenced 2` and `fenced all`
  - [x] rejects too many arguments with the existing error message
- [x] Test block resolution:
  - [x] one block and no selector picks the block
  - [x] multiple blocks and no selector requires the picker
  - [x] valid and invalid numeric selectors
  - [x] `first`/`f`, `last`/`l`
- [x] Test clipboard formatting:
  - [x] unfenced single block returns raw code
  - [x] fenced single block includes language when present and omits `text`
  - [x] all-block formatting joins with the configured blank-line separator

These tests protect the most failure-prone logic without requiring the pi runtime.

## Step 5: Add tests for `pi-copy-code-block` extension integration

- [x] Continue in `extensions/pi-copy-code-block/test/index.test.ts` after mocking external effects.
- [x] Mock `clipboardy` with `vi.mock("clipboardy", () => ({ default: { write: vi.fn() } }))`.
- [x] Use `createMockPi()` and a fake context with `sessionManager.getBranch()` returning assistant/user messages.
- [x] Test that it registers the `copy-code` command.
- [x] Test that it registers the configured shortcut.
- [x] Test that it registers status refresh handlers for `session_start`, `turn_end`, and `session_tree`.
- [x] Test command copies the only code block from the latest completed assistant message:
  - [x] calls `clipboard.write` with the raw code
  - [x] notifies success
- [x] Test command copies `all` blocks and `fenced` blocks correctly.
- [x] Test if multiple blocks exist and no selector is provided:
  - [x] with no UI, warns the user to pass a selector
  - [x] with UI, uses the picker and copies the selected block
- [x] Test that it ignores assistant messages whose `stopReason` is not `stop`.
- [x] Test useful warnings when:
  - [x] no completed assistant message exists
  - [x] completed assistant messages contain no code blocks
  - [x] selector is invalid
- [x] Test status hint:
  - [x] sets a status message when recent assistant code blocks exist
  - [x] clears the status when none exist

## Step 6: Keep existing `pi-interactive-code-review` tests running

- [x] Do not block this plan on adding more tests there because it already has coverage.
- [ ] After the untested extensions are covered, consider a later follow-up plan for:
  - [ ] command registration smoke tests for the review extension
  - [ ] git command integration tests with temporary repositories
  - [ ] review state persistence tests

## Step 7: Run and verify locally

- [x] After adding each extension's tests, run targeted checks first:

```sh
npx vitest run extensions/pi-vim-quit/test
npx vitest run extensions/pi-ask-user-question/test
npx vitest run extensions/pi-copy-code-block/test
```

- [x] Then run the full repository checks:

```sh
npm run typecheck
npm run test
npm run ci
```

## Step 8: CI expectations

- [x] No workflow change should be needed because `.github/workflows/ci.yml` already runs `vp run ci`, and the root `ci` script already includes `npm run test`.
- [ ] If tests are not discovered in CI, add a root `vitest.config.ts` with an explicit include pattern:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["extensions/**/test/**/*.test.ts"],
  },
});
```

## Suggested implementation order

- [x] Shared mock helpers.
- [x] `pi-vim-quit` tests.
- [x] `pi-ask-user-question` tests.
- [x] `pi-copy-code-block` pure-helper exports and unit tests.
- [x] `pi-copy-code-block` command/status integration tests.
- [x] Full `npm run ci` verification.
