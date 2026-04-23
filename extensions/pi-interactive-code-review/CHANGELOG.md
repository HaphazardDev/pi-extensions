# @haphazarddev/pi-interactive-code-review

## 0.1.3

### Patch Changes

- db57a4a: Add a searchable changed-file picker to `/review` with fuzzy filename matching, per-file change summaries, match highlighting, and direct keyboard navigation into the diff viewer. Also add in-file diff search with highlighted matches and next/previous match navigation.

## 0.1.2

### Patch Changes

- 4ba486d: Simplify the review UI controls display by collapsing the footer to a `?` help hint and showing the full controls reference on demand in the lower section. Also make the diff view height-aware so it uses more of the available terminal space while staying within the viewport when comments or help are visible.

## 0.1.1

### Patch Changes

- e23e2cb: Add a word-wrap toggle for long lines in the interactive diff viewer.
