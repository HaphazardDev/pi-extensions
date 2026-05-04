# Interactive Code Review: Child Repository Review Targets

## Goal

Allow `/review` to review changes in a git repository that is not necessarily pi's current working directory, including child repositories such as `repos/test-repo`. The experience should make the active review target obvious, easy to select, and safe to use when multiple repositories are present.

## UX principles

- Make the selected repository visible before and during review.
- Keep existing `/review <base-ref>` behavior working.
- Prefer explicit syntax for ambiguous cases.
- Prioritize repositories with changes.
- Scope review state and agent prompts to the selected repository so threads do not leak between repos.
- Keep the first implementation small enough to ship, then layer on discovery and picker improvements.

---

## Phase 1: Core repo targeting

### Command parsing

- [x] Add support for explicit repo targeting:
  - [x] `/review --repo repos/test-repo`
  - [x] `/review --repo repos/test-repo --base origin/main`
  - [x] `/review --base origin/main`
- [x] Preserve existing behavior:
  - [x] `/review`
  - [x] `/review origin/main`
  - [x] `/review main`
- [x] Add safe bare-argument detection:
  - [x] If a bare arg is an existing directory containing a git repo, treat it as `repoPath`.
  - [x] Otherwise treat the bare arg as `baseRef`.
- [x] Validate invalid argument combinations with a clear UI error.
- [x] Document command syntax in the README.

### Git execution in selected repo

- [x] Introduce a `ReviewTarget` type with at least:
  - [x] `repoPath` absolute path
  - [x] `displayPath` relative to pi cwd when possible
  - [x] `baseRef`
  - [x] `defaultBranch`
- [x] Update `execGit` to run git commands against the target repo, likely using `git -C <repoPath> ...`.
- [x] Update default branch detection to run inside the selected repo.
- [x] Update untracked file detection to run inside the selected repo.
- [x] Update tracked and untracked diff generation to run inside the selected repo.
- [x] Ensure parsed diff file paths remain relative to the selected repository root.
- [x] Add clear error messages for:
  - [x] target path does not exist
  - [x] target path is not a git repo
  - [x] target base ref cannot be resolved
  - [x] merge-base cannot be computed

### Snapshot/state model

- [x] Extend `ReviewSnapshot` to include target metadata:
  - [x] `repoPath`
  - [x] `repoDisplayPath`
  - [x] `baseRef`
  - [x] `defaultBranch`
- [x] Store selected repo metadata in persisted review state.
- [x] Ensure refresh uses the same target repo and base ref.
- [x] Ensure selection restoration only applies within the same target repo.

---

## Phase 2: Make the active target obvious

### Review UI header

- [x] Update the review header to show the selected repo path.
- [x] Include target info in a compact form, for example:
  - [x] `Review repos/test-repo against origin/main`
  - [x] `feature/agent-work • 7 files • +88 -12`
- [x] For the current repo, display either `.` or the current directory basename consistently.
- [x] Keep file paths inside the diff relative to the selected repo.

### Status bar

- [x] Include the review target in status text when queued/awaiting threads exist.
- [x] Example: `🧵 review repos/test-repo • 3 queued • 1 awaiting`
- [x] Avoid making the status too noisy for the current repo case.

### Notifications

- [x] Include the repo target in important notifications:
  - [x] unable to open review
  - [x] refresh failed
  - [x] sent review threads
  - [x] attached review responses

---

## Phase 3: Repo-scoped review threads

### State scoping

- [x] Add a stable target key for persisted state, based on the canonical absolute repo path.
- [x] Use the target key to separate saved review UI state, queued threads, submitted threads, and pending dispatches by repository.
- [x] Store branch and base ref as target metadata, not as part of the target key, so state is scoped to the repo itself while still showing which branch/base created the thread.
- [x] Prevent comments from one repo appearing in another repo's review UI.
- [x] Handle migration from existing unscoped state:
  - [x] Treat old state as belonging to the current repo.
  - [x] Avoid data loss if possible.

### Thread matching

- [x] Include target key/repo path in pending dispatch metadata.
- [x] On `agent_end`, attach responses only to pending threads for the matching repo dispatch.
- [x] Keep existing thread-tag parsing behavior.

### Agent prompt

- [x] Update `buildDispatchPrompt` or call site to include selected repo target.
- [x] Prompt should clearly say that paths are relative to the selected repository root.
- [ ] Example prompt addition:

  ```text
  Repository under review: repos/test-repo
  Please interpret file paths relative to that repository root.
  ```

- [x] If possible, instruct the agent to make changes in the selected repo path from the parent cwd.

---

## Phase 4: Child repo discovery

### Discovery implementation

- [x] Add repository discovery from pi cwd.
- [x] Include the parent/outer git repo when pi cwd is inside a nested child repo; plain `/review` should review that parent repo by default in this case.
- [x] Keep the innermost/current child repo selectable via explicit `--repo .`, `--current`, or the picker when forced.
- [x] Include child directories containing:
  - [x] `.git` directory
  - [x] `.git` file, for worktrees/submodules
- [x] Skip expensive/noisy directories:
  - [x] `.git`
  - [x] `node_modules`
  - [x] `dist`
  - [x] `build`
  - [x] `.next`
  - [x] `coverage`
  - [x] `vendor`
- [x] Use max depth 3 as the default discovery depth.
- [x] Add a configurable override, preferably `/review --scan-depth <n>`, for deeper child repo discovery.
- [x] Add a hard cap on discovered repos to avoid slow scans.
- [x] Consider caching discovered repos for the session.

### Repo summaries

- [x] For each discovered repo, compute:
  - [x] relative display path
  - [x] current branch
  - [x] default branch or base ref
  - [x] changed file count
  - [x] insertions/deletions summary
  - [x] clean/dirty status
- [x] Keep summary collection fast and resilient.
- [x] If a summary command fails for one repo, show that repo with an error badge instead of failing the whole picker.

---

## Phase 5: Target picker

### When to show picker

- [x] Show a picker for `/review` when multiple dirty candidate repos are discovered.
- [x] If exactly one candidate repo has changes, auto-open it without showing the picker, even when that repo is a child repo.
- [x] Hide clean child repos from the default picker.
- [x] If no dirty repos are found, show the default target with an empty/clean state instead of listing every clean child repo.
- [x] If an explicit `--repo` is provided, skip the picker.
- [x] If a bare base ref is provided, default to the parent/current review target unless target selection is explicitly requested.

### Picker content

- [x] Add a target picker UI with rows like:

  ```text
  › .                         current repo     feature/foo  4 files  +120 -31
    repos/test-repo           child repo       agent-work   7 files  +88 -12
  ```

  Clean child repos are hidden by default. If a future `--include-clean` flag is used, clean repos can be shown at the bottom, for example:

  ```text
    repos/other-repo          child repo       main         clean
  ```

- [x] Display per-row fields:
  - [x] repo display path
  - [x] target type: current repo / child repo / worktree / submodule if detectable
  - [x] branch
  - [x] changed file count
  - [x] `+/-` summary
  - [x] dirty/error badge
  - [x] clean badge only when clean repos are explicitly included
- [x] Add fuzzy filtering by repo path.
- [x] Highlight matched characters in repo paths.
- [x] Support keyboard controls:
  - [x] `↑` / `↓` move selection
  - [x] `Ctrl+N` / `Ctrl+P` alternate movement
  - [x] `Enter` select target
  - [x] `Esc` cancel
  - [x] `F1` / `Alt+H` help

### Picker ranking

- [x] Rank candidates in a useful order:
  - [x] explicit target first, if any
  - [x] repos with changes
  - [x] repos on a non-default branch
  - [x] recently reviewed repo
  - [x] parent/current review target
  - [x] clean repos only when explicitly included, sorted last
- [x] Make the default selected row the most likely useful target.

---

## Phase 6: Recent targets and polish

### Recent target memory

- [x] Track recently reviewed repos in persisted/session state.
- [x] Place recent targets near the top of the picker.
- [x] Show a small recency hint, for example `last reviewed 3m ago`.
- [x] Decide whether `/review` should default to the last target or only preselect it.

### Additional command conveniences

- [x] Consider `/review --pick` to force the target picker.
- [x] Add `/review --scan-depth 6` or `/review --scan-depth <n>` for deeper child repo discovery.
- [x] Consider `/review --include-clean` to show clean child repos in the picker.
- [x] Consider `/review --current` to force the innermost/current repo and skip parent-repo defaulting.
- [x] Consider tab/completion support if pi commands expose completion APIs.

### README and help text

- [x] Update README usage examples.
- [x] Update notes explaining that paths are relative to the selected repo.
- [x] Update in-UI help to mention target selection if relevant.
- [x] Add troubleshooting notes for child repos and invalid base refs.

---

## Phase 7: Tests

### Unit tests

- [x] Test command parsing:
  - [x] explicit `--repo`
  - [x] explicit `--base`
  - [x] existing bare base ref behavior
  - [x] bare repo directory behavior
  - [x] invalid combinations
- [x] Test target key generation.
- [x] Test state scoping by repo.
- [x] Test state migration from old unscoped state.
- [x] Test repo discovery skip rules.
- [x] Test picker ranking.
- [x] Test prompt formatting with repo target metadata.

### Integration/manual tests

- [ ] Current repo only:
  - [ ] `/review`
  - [ ] `/review origin/main`
- [ ] Parent repo with dirty child repo:
  - [ ] `/review --repo repos/test-repo`
  - [ ] `/review --repo repos/test-repo --base origin/main`
  - [ ] `/review` auto-opens the dirty child repo when it is the only dirty candidate
- [ ] Parent repo and child repo both dirty.
- [ ] Clean child repo is hidden from the default picker.
- [ ] Clean child repo appears as clean only when `--include-clean` is used.
- [ ] Only dirty child repo auto-opens without showing the picker.
- [ ] When pi cwd is inside a nested child repo, plain `/review` targets the parent git repo by default.
- [ ] Child repo with invalid/missing base ref shows a helpful error.
- [ ] Queued comments in parent repo do not appear in child repo.
- [ ] Queued comments in child repo do not appear in parent repo.
- [ ] Agent responses attach to the correct child repo threads.
- [ ] Refresh keeps the same target repo.

> Manual/integration checks remain unchecked until they are exercised in the interactive pi UI.

---

## Suggested implementation order

1. Implement `ReviewTarget` and `git -C <repo>` plumbing.
2. Add command parsing for `--repo` and `--base`.
3. Show target in the review header and dispatch prompt.
4. Scope persisted threads by target key.
5. Add tests for parsing, target selection, and state scoping.
6. Add child repo discovery.
7. Add target picker.
8. Add recents and polish.

## Resolved decisions

- `/review` should auto-open the only dirty candidate repo, including when that candidate is a child repo.
- Child repo discovery should default to max depth 3.
- Deeper discovery should be configurable, preferably with `/review --scan-depth <n>`.
- Clean child repos should be hidden by default and only shown through an explicit option such as `/review --include-clean`.
- The target key means the stable identifier used to keep persisted review state separated by repository. Use the canonical absolute repo path as the key; store branch and base ref as metadata rather than as part of the key.
- When pi cwd is inside a nested child repo, plain `/review` should target the parent git repo by default. The child repo should remain available through explicit targeting, for example `/review --repo .` or `/review --current`.
