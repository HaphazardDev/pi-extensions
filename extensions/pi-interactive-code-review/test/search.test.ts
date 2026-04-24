import { describe, expect, it } from "vitest";
import { findDiffSearchMatches, scoreFileJumpMatch } from "../src/search.js";
import type { DiffFile } from "../src/types.js";

const file: DiffFile = {
  filePath: "src/components/ReviewBrowser.ts",
  displayPath: "src/components/ReviewBrowser.ts",
  oldPath: "src/components/ReviewBrowser.ts",
  newPath: "src/components/ReviewBrowser.ts",
  status: "modified",
  additions: 1,
  deletions: 0,
  hunks: [
    {
      header: "@@ -1,2 +1,2 @@",
      oldStart: 1,
      oldLines: 2,
      newStart: 1,
      newLines: 2,
      lines: [
        { kind: "context", text: "function renderReviewBrowser() {", oldLineNumber: 1, newLineNumber: 1 },
        { kind: "add", text: "  return new ReviewBrowser();", newLineNumber: 2 },
      ],
    },
  ],
};

describe("review search helpers", () => {
  it("scores file jump matches against the basename", () => {
    const match = scoreFileJumpMatch("rev brow", file);

    expect(match).not.toBeNull();
    expect(match!.score).toBeGreaterThan(0);
    expect(match!.labelPositions.length).toBeGreaterThan(0);
  });

  it("finds case-insensitive diff search matches", () => {
    expect(findDiffSearchMatches(file, "reviewbrowser")).toEqual([
      { hunkIndex: 0, lineIndex: 0, positions: Array.from({ length: 13 }, (_, index) => 15 + index) },
      { hunkIndex: 0, lineIndex: 1, positions: Array.from({ length: 13 }, (_, index) => 13 + index) },
    ]);
  });
});
