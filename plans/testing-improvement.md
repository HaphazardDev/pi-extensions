# Testing improvement plan

## Goal

Add a small, useful Vitest test suite for every extension so that the core behaviors are protected by `npm run ci` / GitHub Actions before making future changes.

## Current state

- [x] Root `package.json` already has the right CI path:
  - [x] `npm run test` runs `vitest run`.
  - [x] `npm run ci` runs typecheck, tests, and package dry-runs.
  - [x] `.github/workflows/ci.yml` runs `vp run ci`.
- [x] `extensions/pi-interactive-code-review` already has unit tests under `test/`.
- [ ] These extensions currently need tests:
  - [ ] `extensions/pi-vim-quit`
  - [ ] `extensions/pi-ask-user-question`
  - [ ] `extensions/pi-copy-code-block`

## Principles

- [ ] Prefer fast unit tests around pure logic and extension registration behavior.
- [ ] Add only enough integration-style mocking to verify that each extension wires into pi correctly.
- [ ] Keep tests deterministic: mock clipboard, UI methods, and session state.
- [ ] Avoid testing pi internals; test the extension's contract with the pi API.
- [ ] When useful, export small pure helpers from `src/index.ts` rather than reaching into private implementation details.

## Step 1: Add a shared test helper for fake pi APIs

- [ ] Create `extensions/test-utils/pi.ts` or `test/helpers/pi.ts` with minimal mocks used by multiple extensions.
- [ ] Add `createMockPi()` that records calls to:
  - [ ] `on(event, handler)`
  - [ ] `registerTool(tool)`
  - [ ] `registerCommand(name, command)`
  - [ ] `registerShortcut(shortcut, shortcut)`
- [ ] Add `createMockUi()` with spies for:
  - [ ] `notify`
  - [ ] `confirm`
  - [ ] `input`
  - [ ] `editor`
  - [ ] `custom`
  - [ ] `setStatus`
  - [ ] `theme.fg`
- [ ] Add `createMockContext()` that can be configured with:
  - [ ] `hasUI`
  - [ ] `ui`
  - [ ] `shutdown`
  - [ ] `sessionManager.getBranch()`
- [ ] Keep these helpers deliberately small and typed loosely where necessary so tests do not become coupled to all pi API details.

## Step 2: Add tests for `pi-vim-quit`

- [ ] Create `extensions/pi-vim-quit/test/index.test.ts`.
- [ ] Test that it registers an `input` event handler.
- [ ] Test `:q`, `:qa`, and `:wq` from a normal user input source:
  - [ ] returns `{ action: "handled" }`
  - [ ] calls `ctx.ui.notify("Quitting pi…", "info")`
  - [ ] calls `ctx.shutdown()`
- [ ] Test non-quit input:
  - [ ] returns `{ action: "continue" }`
  - [ ] does not notify
  - [ ] does not call shutdown
- [ ] Test input with `event.source === "extension"`:
  - [ ] returns `{ action: "continue" }`
  - [ ] does not call shutdown, even if the text is `:q`

This gives high confidence for the entire extension because its behavior is intentionally tiny.

## Step 3: Add tests for `pi-ask-user-question`

- [ ] Create `extensions/pi-ask-user-question/test/index.test.ts`.
- [ ] Test that it registers the `ask_user_question` tool with the expected name and basic metadata.
- [ ] Test no UI available:
  - [ ] execute with `ctx.hasUI = false`
  - [ ] returns an error text response
  - [ ] returns details with `cancelled: true`, `answer: null`, and `mode: "input"`
- [ ] Test confirm mode:
  - [ ] when `ctx.ui.confirm` resolves `true`, returns `User confirmed: yes` and details answer `"yes"`
  - [ ] when it resolves `false`, returns `User answered: no` and details answer `"no"`
- [ ] Test free-form input mode:
  - [ ] trims a non-empty answer and records `mode: "input"`
  - [ ] treats empty/whitespace answers as cancelled
- [ ] Test editor mode:
  - [ ] uses `ctx.ui.editor` when `multiline` is true or `initialValue` is provided
  - [ ] trims a non-empty answer and records `mode: "editor"`
- [ ] Test options mode:
  - [ ] uses `ctx.ui.custom` to choose an option
  - [ ] records `mode: "select"` and the selected answer
  - [ ] returns cancelled details when the custom picker returns `null`
- [ ] Test custom option flow:
  - [ ] when `allowCustomAnswer` is not false and the custom label is selected, prompts for input/editor
  - [ ] when `allowCustomAnswer: false`, does not include the custom answer option

Implementation note: `ctx.ui.custom` can call the component and simulate selecting by either invoking the returned `handleInput` with a numeric key / enter, or more simply by capturing the `done` callback and calling it with the desired choice.

## Step 4: Add tests for `pi-copy-code-block` pure behavior

- [ ] Create `extensions/pi-copy-code-block/test/index.test.ts`, or split into focused files such as `parse.test.ts` and `command.test.ts`.
- [ ] Refactor `src/index.ts` to export these helpers for direct unit tests:
  - [ ] `extractCodeBlocks`
  - [ ] `parseCopyRequest`
  - [ ] `resolveRequestedBlock`
  - [ ] `formatSingleBlockForClipboard`
  - [ ] `formatAllBlocksForClipboard`
- [ ] Test code block extraction:
  - [ ] extracts fenced Markdown blocks and languages
  - [ ] normalizes CRLF to LF
  - [ ] removes the structural newline before the closing fence
  - [ ] returns blocks in the order shown by the picker/selector, including correct indexes
  - [ ] ignores text without fenced code blocks
- [ ] Test request parsing:
  - [ ] empty input means single block, unfenced
  - [ ] numeric selector, `first`, `last`, `all`
  - [ ] `fenced 2` and `fenced all`
  - [ ] rejects too many arguments with the existing error message
- [ ] Test block resolution:
  - [ ] one block and no selector picks the block
  - [ ] multiple blocks and no selector requires the picker
  - [ ] valid and invalid numeric selectors
  - [ ] `first`/`f`, `last`/`l`
- [ ] Test clipboard formatting:
  - [ ] unfenced single block returns raw code
  - [ ] fenced single block includes language when present and omits `text`
  - [ ] all-block formatting joins with the configured blank-line separator

These tests protect the most failure-prone logic without requiring the pi runtime.

## Step 5: Add tests for `pi-copy-code-block` extension integration

- [ ] Continue in `extensions/pi-copy-code-block/test/index.test.ts` after mocking external effects.
- [ ] Mock `clipboardy` with `vi.mock("clipboardy", () => ({ default: { write: vi.fn() } }))`.
- [ ] Use `createMockPi()` and a fake context with `sessionManager.getBranch()` returning assistant/user messages.
- [ ] Test that it registers the `copy-code` command.
- [ ] Test that it registers the configured shortcut.
- [ ] Test that it registers status refresh handlers for `session_start`, `turn_end`, and `session_tree`.
- [ ] Test command copies the only code block from the latest completed assistant message:
  - [ ] calls `clipboard.write` with the raw code
  - [ ] notifies success
- [ ] Test command copies `all` blocks and `fenced` blocks correctly.
- [ ] Test if multiple blocks exist and no selector is provided:
  - [ ] with no UI, warns the user to pass a selector
  - [ ] with UI, uses the picker and copies the selected block
- [ ] Test that it ignores assistant messages whose `stopReason` is not `stop`.
- [ ] Test useful warnings when:
  - [ ] no completed assistant message exists
  - [ ] completed assistant messages contain no code blocks
  - [ ] selector is invalid
- [ ] Test status hint:
  - [ ] sets a status message when recent assistant code blocks exist
  - [ ] clears the status when none exist

## Step 6: Keep existing `pi-interactive-code-review` tests running

- [ ] Do not block this plan on adding more tests there because it already has coverage.
- [ ] After the untested extensions are covered, consider a later follow-up plan for:
  - [ ] command registration smoke tests for the review extension
  - [ ] git command integration tests with temporary repositories
  - [ ] review state persistence tests

## Step 7: Run and verify locally

- [ ] After adding each extension's tests, run targeted checks first:

```sh
npx vitest run extensions/pi-vim-quit/test
npx vitest run extensions/pi-ask-user-question/test
npx vitest run extensions/pi-copy-code-block/test
```

- [ ] Then run the full repository checks:

```sh
npm run typecheck
npm run test
npm run ci
```

## Step 8: CI expectations

- [ ] No workflow change should be needed because `.github/workflows/ci.yml` already runs `vp run ci`, and the root `ci` script already includes `npm run test`.
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

- [ ] Shared mock helpers.
- [ ] `pi-vim-quit` tests.
- [ ] `pi-ask-user-question` tests.
- [ ] `pi-copy-code-block` pure-helper exports and unit tests.
- [ ] `pi-copy-code-block` command/status integration tests.
- [ ] Full `npm run ci` verification.
