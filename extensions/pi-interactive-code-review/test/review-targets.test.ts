import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getReviewTargetKey,
  parseReviewArgs,
  rankDiscoveredRepos,
  walkChildRepoCandidates,
  type DiscoveredRepo,
} from "../src/index.js";
import { countAwaitingThreads, countQueuedThreads } from "../src/format.js";
import { buildDispatchPrompt } from "../src/threads.js";
import type { PersistedReviewState, ReviewThread } from "../src/types.js";

const originalCwd = process.cwd();

afterEach(() => {
  process.chdir(originalCwd);
});

function baseThread(overrides: Partial<ReviewThread> = {}): ReviewThread {
  return {
    id: "review-1",
    repoPath: "/tmp/project/repos/test-repo",
    repoDisplayPath: "repos/test-repo",
    baseRef: "origin/main",
    filePath: "src/index.ts",
    displayPath: "src/index.ts",
    target: { kind: "file" },
    excerpt: "+hello",
    comment: "Please check this",
    commentKind: "comment",
    dispatchMode: "batch",
    state: "queued",
    createdAt: 1,
    ...overrides,
  };
}

function baseState(overrides: Partial<PersistedReviewState> = {}): PersistedReviewState {
  return {
    version: 1,
    repoPath: "/tmp/project/repos/test-repo",
    repoDisplayPath: "repos/test-repo",
    nextThreadId: 2,
    selection: {},
    threads: [],
    pendingDispatches: [],
    recentTargets: [],
    ...overrides,
  };
}

describe("review target argument parsing", () => {
  it("parses explicit repo and base flags", () => {
    expect(parseReviewArgs("--repo repos/test-repo --base origin/main")).toEqual({
      repoPath: "repos/test-repo",
      baseRef: "origin/main",
    });
  });

  it("preserves bare base ref behavior", () => {
    expect(parseReviewArgs("origin/main")).toEqual({ baseRef: "origin/main" });
  });

  it("treats a bare git directory as a repo target", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-target-"));
    fs.mkdirSync(path.join(tmp, "child", ".git"), { recursive: true });
    process.chdir(tmp);

    expect(parseReviewArgs("child")).toEqual({ repoPath: "child" });
  });

  it("parses discovery convenience flags", () => {
    expect(parseReviewArgs("--pick --include-clean --scan-depth 6")).toEqual({
      pick: true,
      includeClean: true,
      scanDepth: 6,
    });
  });

  it("rejects invalid scan depths", () => {
    expect(() => parseReviewArgs("--scan-depth nope")).toThrow(/scan-depth/);
  });
});

describe("review target keys and state scoping", () => {
  it("normalizes target keys to absolute paths", () => {
    expect(getReviewTargetKey(".")).toBe(path.resolve("."));
  });

  it("counts only threads for the active repo", () => {
    const state = baseState({
      threads: [
        baseThread({ id: "review-1", state: "queued", repoPath: "/tmp/project/repos/test-repo" }),
        baseThread({ id: "review-2", state: "queued", repoPath: "/tmp/project/other-repo" }),
        baseThread({ id: "review-3", state: "submitted", repoPath: "/tmp/project/repos/test-repo" }),
      ],
    });

    expect(countQueuedThreads(state)).toBe(1);
    expect(countAwaitingThreads(state)).toBe(1);
  });

  it("treats old unscoped threads as belonging to the active repo for migration", () => {
    const state = baseState({
      threads: [baseThread({ repoPath: undefined, state: "queued" })],
    });

    expect(countQueuedThreads(state)).toBe(1);
  });
});

describe("review target discovery helpers", () => {
  it("skips noisy directories while discovering child repos", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-discovery-"));
    fs.mkdirSync(path.join(tmp, "node_modules", "pkg", ".git"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "repos", "test-repo", ".git"), { recursive: true });

    expect(walkChildRepoCandidates(tmp, { maxDepth: 3, maxRepos: 10 })).toEqual([
      path.join(tmp, "repos", "test-repo"),
    ]);
  });

  it("ranks dirty, non-default, recent, and parent/current repos first", () => {
    const repos: DiscoveredRepo[] = [
      { repoPath: "/clean-child", displayPath: "clean-child", kind: "child", changedFiles: 0, additions: 0, deletions: 0, dirty: false },
      { repoPath: "/dirty-child", displayPath: "dirty-child", kind: "child", branch: "main", defaultBranch: "origin/main", changedFiles: 1, additions: 1, deletions: 0, dirty: true },
      { repoPath: "/feature-child", displayPath: "feature-child", kind: "child", branch: "feature", defaultBranch: "origin/main", changedFiles: 1, additions: 1, deletions: 0, dirty: true },
      { repoPath: "/parent", displayPath: ".", kind: "parent", changedFiles: 0, additions: 0, deletions: 0, dirty: false },
    ];

    expect(rankDiscoveredRepos(repos, [{ repoPath: "/clean-child", reviewedAt: 10 }]).map((repo) => repo.repoPath)).toEqual([
      "/feature-child",
      "/dirty-child",
      "/clean-child",
      "/parent",
    ]);
  });
});

describe("review target prompt formatting", () => {
  it("includes repository target metadata", () => {
    const prompt = buildDispatchPrompt("origin/main", [baseThread()]);

    expect(prompt).toContain("Repository under review: repos/test-repo");
    expect(prompt).toContain("Please interpret file paths relative to that repository root.");
  });
});
