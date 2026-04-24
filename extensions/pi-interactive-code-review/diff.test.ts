import { describe, expect, it } from "vitest";
import { parseGitDiff } from "./diff.js";

describe("parseGitDiff", () => {
  it("parses modified file hunks with line numbers and counts", () => {
    const files = parseGitDiff(`diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,4 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 const d = 5;
`);

    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      filePath: "src/app.ts",
      displayPath: "src/app.ts",
      status: "modified",
      additions: 2,
      deletions: 1,
    });
    expect(files[0]!.hunks[0]!.lines).toEqual([
      { kind: "context", text: "const a = 1;", oldLineNumber: 1, newLineNumber: 1 },
      { kind: "del", text: "const b = 2;", oldLineNumber: 2 },
      { kind: "add", text: "const b = 3;", newLineNumber: 2 },
      { kind: "add", text: "const c = 4;", newLineNumber: 3 },
      { kind: "context", text: "const d = 5;", oldLineNumber: 3, newLineNumber: 4 },
    ]);
  });

  it("marks rename-only and binary changes as file-level review targets", () => {
    const files = parseGitDiff(`diff --git a/old.ts b/new.ts
similarity index 100%
rename from old.ts
rename to new.ts
diff --git a/logo.png b/logo.png
index 1111111..2222222 100644
Binary files a/logo.png and b/logo.png differ
`);

    expect(files[0]).toMatchObject({
      filePath: "new.ts",
      displayPath: "old.ts → new.ts",
      status: "renamed",
      note: "Rename-only change. Use file-level comments to discuss this rename.",
    });
    expect(files[1]).toMatchObject({
      filePath: "logo.png",
      status: "modified",
      note: "Binary file changed. Use a file-level comment to review it.",
    });
  });
});
