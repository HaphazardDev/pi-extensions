import { describe, expect, it } from "vitest";
import { parseReviewArgs } from "../src/index.js";
import { buildDispatchPrompt } from "../src/threads.js";
import type { ReviewThread } from "../src/types.js";

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

describe("review target prompt formatting", () => {
  it("includes repository target metadata", () => {
    const thread: ReviewThread = {
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
    };

    const prompt = buildDispatchPrompt("origin/main", [thread]);

    expect(prompt).toContain("Repository under review: repos/test-repo");
    expect(prompt).toContain("Please interpret file paths relative to that repository root.");
  });
});
