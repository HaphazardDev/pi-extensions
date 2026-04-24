import { describe, expect, it } from "vitest";
import { buildDispatchPrompt, parseThreadResponses } from "./threads.js";
import type { ReviewThread } from "./types.js";

const baseThread: ReviewThread = {
  id: "thread-1",
  filePath: "src/app.ts",
  displayPath: "src/app.ts",
  target: { kind: "line", newLineNumber: 12, hunkHeader: "@@ -10,3 +10,3 @@" },
  excerpt: "+newCode();",
  comment: "Can this be simplified?",
  commentKind: "question",
  dispatchMode: "batch",
  state: "queued",
  createdAt: 1,
};

describe("review thread prompts", () => {
  it("builds a dispatch prompt with required response format and thread context", () => {
    const prompt = buildDispatchPrompt("origin/main", [baseThread]);

    expect(prompt).toContain("against origin/main");
    expect(prompt).toContain("[[thread:<id>]]");
    expect(prompt).toContain("Thread ID: thread-1");
    expect(prompt).toContain("File: src/app.ts");
    expect(prompt).toContain("Target: L12");
    expect(prompt).toContain("Can this be simplified?");
  });

  it("parses tagged assistant responses and defaults missing status to answered", () => {
    const responses = parseThreadResponses(`[[thread:thread-1]]
Status: changed
Response:
Updated the code.

[[thread:thread-2]]
Response:
Looks good as-is.
`);

    expect(responses.get("thread-1")).toEqual({ status: "changed", responseText: "Updated the code." });
    expect(responses.get("thread-2")).toEqual({ status: "answered", responseText: "Looks good as-is." });
  });
});
