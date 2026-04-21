# @haphazarddev/pi-interactive-code-review

Review your current branch and working tree like a pull request, directly inside pi.

It opens an interactive diff browser against your default branch, lets you move file by file and hunk by hunk, attach review comments to lines, hunks, or whole files, and then either batch those comments or send them to the agent immediately.

When the agent replies, the extension stores the response on the matching review thread so you can reopen the review UI and follow the conversation inline with the diff.

## Install

```bash
pi install npm:@haphazarddev/pi-interactive-code-review
```

Or from a local checkout:

```bash
pi install ./extensions/pi-interactive-code-review
```

## Usage

Open the review UI:

```bash
/review
```

Optionally review against a specific ref instead of the detected default branch:

```bash
/review origin/main
/review main
```

## Controls

Inside the review UI:

### Movement

- `Tab` / `Shift+Tab` - next/previous changed file
- `[` - previous hunk
- `]` - next hunk
- `↑` / `↓` - move through lines in the current hunk

### Extra shortcuts shown in `?` help

- `n` / `p` - next/previous changed file
- `j` / `k` - move through lines in the current hunk
- `d` / `u` - move down/up half a page in the current hunk

### Actions

- `c` - start an inline line comment or question
- `H` - start an inline hunk comment or question
- `F` - start an inline file-level comment or question
- `1-4` or `e` - edit a visible comment thread inline
- `x` or `Backspace` - delete a visible comment thread
- `s` - send all queued review comments as one batch
- `r` - refresh the diff against the current base ref
- `?` - toggle help
- `Esc` / `q` - close

While the inline comment editor is open:

- `Enter` - save the comment
- `Shift+Enter` - insert a newline
- `Tab` - toggle between **batch** and **immediate** send mode
- `Esc` - cancel editing

## Review flow

1. Open `/review`
2. Navigate through the diff file by file
3. Add comments/questions inline while still seeing the diff above the editor
4. Use `Tab` in the inline editor to choose either:
   - **batch** to queue the thread
   - **immediate** to have the agent address it right away
5. Press `s` when you want to send the whole queued batch
6. Use `1-4` or `e` to reopen and edit visible comments
7. Sending comments closes the review UI so pi can run the review turn cleanly
8. Reopen `/review` to see agent responses attached to the relevant threads

## Notes

- The extension compares the merge-base of your review base and `HEAD` against your current working tree, so committed, staged, unstaged, and untracked file changes are all reviewable.
- Default branch detection prefers `origin/HEAD`, then falls back to `origin/main`, `origin/master`, `main`, and `master`.
- Review thread state is stored in the session, so queued comments and agent responses survive reloads and session switches on the same branch.
- Agent replies are requested in a thread-tagged format so the extension can attach them back to the correct line/hunk/file thread.

## Repository

- Source: https://github.com/HaphazardDev/pi-extensions
- Issues: https://github.com/HaphazardDev/pi-extensions/issues
