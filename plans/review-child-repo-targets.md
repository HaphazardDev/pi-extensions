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

- [ ] Add support for explicit repo targeting:
  - [ ] `/review --repo repos/test-repo`
  - [ ] `/review --repo repos/test-repo --base origin/main`
  - [ ] `/review --base origin/main`
- [ ] Preserve existing behavior:
  - [ ] `/review`
  - [ ] `/review origin/main`
  - [ ] `/review main`
- [ ] Add safe bare-argument detection:
  - [ ] If a bare arg is an existing directory containing a git repo, treat it as `repoPath`.
  - [ ] Otherwise treat the bare arg as `baseRef`.
- [ ] Validate invalid argument combinations with a clear UI error.
- [ ] Document command syntax in the README.

### Git execution in selected repo

- [ ] Introduce a `ReviewTarget` type with at least:
  - [ ] `repoPath` absolute path
  - [ ] `displayPath` relative to pi cwd when possible
  - [ ] `baseRef`
  - [ ] `defaultBranch`
- [ ] Update `execGit` to run git commands against the target repo, likely using `git -C <repoPath> ...`.
- [ ] Update default branch detection to run inside the selected repo.
- [ ] Update untracked file detection to run inside the selected repo.
- [ ] Update tracked and untracked diff generation to run inside the selected repo.
- [ ] Ensure parsed diff file paths remain relative to the selected repository root.
- [ ] Add clear error messages for:
  - [ ] target path does not exist
  - [ ] target path is not a git repo
  - [ ] target base ref cannot be resolved
  - [ ] merge-base cannot be computed

### Snapshot/state model

- [ ] Extend `ReviewSnapshot` to include target metadata:
  - [ ] `repoPath`
  - [ ] `repoDisplayPath`
  - [ ] `baseRef`
  - [ ] `defaultBranch`
- [ ] Store selected repo metadata in persisted review state.
- [ ] Ensure refresh uses the same target repo and base ref.
- [ ] Ensure selection restoration only applies within the same target repo.

---

## Phase 2: Make the active target obvious

### Review UI header

- [ ] Update the review header to show the selected repo path.
- [ ] Include target info in a compact form, for example:
  - [ ] `Review repos/test-repo against origin/main`
  - [ ] `feature/agent-work • 7 files • +88 -12`
- [ ] For the current repo, display either `.` or the current directory basename consistently.
- [ ] Keep file paths inside the diff relative to the selected repo.

### Status bar

- [ ] Include the review target in status text when queued/awaiting threads exist.
- [ ] Example: `🧵 review repos/test-repo • 3 queued • 1 awaiting`
- [ ] Avoid making the status too noisy for the current repo case.

### Notifications

- [ ] Include the repo target in important notifications:
  - [ ] unable to open review
  - [ ] refresh failed
  - [ ] sent review threads
  - [ ] attached review responses

---

## Phase 3: Repo-scoped review threads

### State scoping

- [ ] Add a stable target key for persisted state, based on the canonical absolute repo path.
- [ ] Use the target key to separate saved review UI state, queued threads, submitted threads, and pending dispatches by repository.
- [ ] Store branch and base ref as target metadata, not as part of the target key, so state is scoped to the repo itself while still showing which branch/base created the thread.
- [ ] Prevent comments from one repo appearing in another repo's review UI.
- [ ] Handle migration from existing unscoped state:
  - [ ] Treat old state as belonging to the current repo.
  - [ ] Avoid data loss if possible.

### Thread matching

- [ ] Include target key/repo path in pending dispatch metadata.
- [ ] On `agent_end`, attach responses only to pending threads for the matching repo dispatch.
- [ ] Keep existing thread-tag parsing behavior.

### Agent prompt

- [ ] Update `buildDispatchPrompt` or call site to include selected repo target.
- [ ] Prompt should clearly say that paths are relative to the selected repository root.
- [ ] Example prompt addition:

  ```text
  Repository under review: repos/test-repo
  Please interpret file paths relative to that repository root.
  ```

- [ ] If possible, instruct the agent to make changes in the selected repo path from the parent cwd.

---

## Phase 4: Child repo discovery

### Discovery implementation

- [ ] Add repository discovery from pi cwd.
- [ ] Include the parent/outer git repo when pi cwd is inside a nested child repo; plain `/review` should review that parent repo by default in this case.
- [ ] Keep the innermost/current child repo selectable via explicit `--repo .`, `--current`, or the picker when forced.
- [ ] Include child directories containing:
  - [ ] `.git` directory
  - [ ] `.git` file, for worktrees/submodules
- [ ] Skip expensive/noisy directories:
  - [ ] `.git`
  - [ ] `node_modules`
  - [ ] `dist`
  - [ ] `build`
  - [ ] `.next`
  - [ ] `coverage`
  - [ ] `vendor`
- [ ] Use max depth 3 as the default discovery depth.
- [ ] Add a configurable override, preferably `/review --scan-depth <n>`, for deeper child repo discovery.
- [ ] Add a hard cap on discovered repos to avoid slow scans.
- [ ] Consider caching discovered repos for the session.

### Repo summaries

- [ ] For each discovered repo, compute:
  - [ ] relative display path
  - [ ] current branch
  - [ ] default branch or base ref
  - [ ] changed file count
  - [ ] insertions/deletions summary
  - [ ] clean/dirty status
- [ ] Keep summary collection fast and resilient.
- [ ] If a summary command fails for one repo, show that repo with an error badge instead of failing the whole picker.

---

## Phase 5: Target picker

### When to show picker

- [ ] Show a picker for `/review` when multiple dirty candidate repos are discovered.
- [ ] If exactly one candidate repo has changes, auto-open it without showing the picker, even when that repo is a child repo.
- [ ] Hide clean child repos from the default picker.
- [ ] If no dirty repos are found, show the default target with an empty/clean state instead of listing every clean child repo.
- [ ] If an explicit `--repo` is provided, skip the picker.
- [ ] If a bare base ref is provided, default to the parent/current review target unless target selection is explicitly requested.

### Picker content

- [ ] Add a target picker UI with rows like:

  ```text
  › .                         current repo     feature/foo  4 files  +120 -31
    repos/test-repo           child repo       agent-work   7 files  +88 -12
  ```

  Clean child repos are hidden by default. If a future `--include-clean` flag is used, clean repos can be shown at the bottom, for example:

  ```text
    repos/other-repo          child repo       main         clean
  ```

- [ ] Display per-row fields:
  - [ ] repo display path
  - [ ] target type: current repo / child repo / worktree / submodule if detectable
  - [ ] branch
  - [ ] changed file count
  - [ ] `+/-` summary
  - [ ] dirty/error badge
  - [ ] clean badge only when clean repos are explicitly included
- [ ] Add fuzzy filtering by repo path.
- [ ] Highlight matched characters in repo paths.
- [ ] Support keyboard controls:
  - [ ] `↑` / `↓` move selection
  - [ ] `Ctrl+N` / `Ctrl+P` alternate movement
  - [ ] `Enter` select target
  - [ ] `Esc` cancel
  - [ ] `F1` / `Alt+H` help

### Picker ranking

- [ ] Rank candidates in a useful order:
  - [ ] explicit target first, if any
  - [ ] repos with changes
  - [ ] repos on a non-default branch
  - [ ] recently reviewed repo
  - [ ] parent/current review target
  - [ ] clean repos only when explicitly included, sorted last
- [ ] Make the default selected row the most likely useful target.

---

## Phase 6: Recent targets and polish

### Recent target memory

- [ ] Track recently reviewed repos in persisted/session state.
- [ ] Place recent targets near the top of the picker.
- [ ] Show a small recency hint, for example `last reviewed 3m ago`.
- [ ] Decide whether `/review` should default to the last target or only preselect it.

### Additional command conveniences

- [ ] Consider `/review --pick` to force the target picker.
- [ ] Add `/review --scan-depth 6` or `/review --scan-depth <n>` for deeper child repo discovery.
- [ ] Consider `/review --include-clean` to show clean child repos in the picker.
- [ ] Consider `/review --current` to force the innermost/current repo and skip parent-repo defaulting.
- [ ] Consider tab/completion support if pi commands expose completion APIs.

### README and help text

- [ ] Update README usage examples.
- [ ] Update notes explaining that paths are relative to the selected repo.
- [ ] Update in-UI help to mention target selection if relevant.
- [ ] Add troubleshooting notes for child repos and invalid base refs.

---

## Phase 7: Tests

### Unit tests

- [ ] Test command parsing:
  - [ ] explicit `--repo`
  - [ ] explicit `--base`
  - [ ] existing bare base ref behavior
  - [ ] bare repo directory behavior
  - [ ] invalid combinations
- [ ] Test target key generation.
- [ ] Test state scoping by repo.
- [ ] Test state migration from old unscoped state.
- [ ] Test repo discovery skip rules.
- [ ] Test picker ranking.
- [ ] Test prompt formatting with repo target metadata.

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
