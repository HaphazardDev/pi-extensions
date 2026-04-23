# @haphazarddev/pi-interactive-code-review

Review your current branch and working tree like a pull request, directly inside pi.

It opens an interactive diff browser against your default branch, lets you move file by file and hunk by hunk, toggle word wrap for long diff lines, open a searchable changed-file list with per-file +/- summaries, attach review comments to lines, hunks, or whole files, and then either batch those comments or send them to the agent immediately.

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

Inside the review UI, press `?` to show the full control reference in the lower section.


### Movement

- `Tab` / `Shift+Tab` - next/previous changed file
- `[` - previous hunk
- `]` - next hunk
- `↑` / `↓` - move through lines in the current hunk

### Extra shortcuts shown in `?` help

- `n` / `p` - next/previous changed file when diff search is not active
- `j` / `k` - move through lines in the current hunk
- `d` / `u` or `Ctrl+D` / `Ctrl+U` - move down/up half a page in the current hunk

### Actions

- `/` - search within the current file diff
- `g` - open the changed-file picker with fuzzy filename matching and per-file summaries
- `c` - start an inline line comment or question
- `H` - start an inline hunk comment or question
- `F` - start an inline file-level comment or question
- `1-4` or `e` - edit a visible comment thread inline
- `x` or `Backspace` - delete a visible comment thread
- `s` - send all queued review comments as one batch
- `r` - refresh the diff against the current base ref
- `w` - toggle word wrap in the diff viewer
- `?` - toggle help
- `F1` / `Alt+H` - toggle help, including while a text input is focused
- `Esc` / `q` - close

While the file picker is open:

- type to fuzzy-match changed files by filename only
- matched characters are highlighted in the picker
- typing resets selection to the top-ranked result
- `↑` / `↓` - move the selected match while keeping focus in the filter input
- `Ctrl+N` / `Ctrl+P` - alternate next/previous match keys
- `Enter` - jump to the selected file
- `F1` / `Alt+H` - toggle help without leaving the filter input
- `Esc` - close the picker

While diff search is open:

- type to search within the current file diff
- visible matches are highlighted in the diff view
- `↑` / `↓` - move between matches while keeping focus in the search input
- `Ctrl+N` / `Ctrl+P` - alternate next/previous match keys
- `Enter` - jump to the selected match and close the search input
- `Esc` - close the search input and keep the current search active
- `n` / `N` - move to the next/previous match after closing the search input
- `F1` / `Alt+H` - toggle help without leaving the search input

While the inline comment editor is open:

- `Enter` - save the comment
- `Shift+Enter` - insert a newline
- `Tab` - toggle between **batch** and **immediate** send mode
- `F1` / `Alt+H` - toggle help without leaving the editor
- `Esc` - cancel editing

## Review flow

1. Open `/review`
2. Navigate through the diff file by file, press `g` to jump through a fuzzy searchable file list with `+added` / `-removed` summaries, or press `/` to search inside the current file diff
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
