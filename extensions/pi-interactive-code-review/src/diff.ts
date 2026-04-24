import type { DiffFile, DiffHunk } from "./types.js";

function unquoteGitPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) return trimmed;
  return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

function parseHunkHeader(line: string): DiffHunk | null {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
  if (!match) return null;
  return {
    header: line,
    oldStart: Number(match[1]),
    oldLines: match[2] ? Number(match[2]) : 1,
    newStart: Number(match[3]),
    newLines: match[4] ? Number(match[4]) : 1,
    lines: [],
  };
}

export function parseGitDiff(rawDiff: string): DiffFile[] {
  const lines = rawDiff.replace(/\r\n/g, "\n").split("\n");
  const files: DiffFile[] = [];

  let currentFile: DiffFile | undefined;
  let currentHunk: DiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;

  const finishHunk = () => {
    if (currentFile && currentHunk) currentFile.hunks.push(currentHunk);
    currentHunk = undefined;
  };

  const finishFile = () => {
    finishHunk();
    if (!currentFile) return;
    if (currentFile.hunks.length === 0 && !currentFile.note) {
      currentFile.note =
        currentFile.status === "renamed"
          ? "Rename-only change. Use file-level comments to discuss this rename."
          : "No textual hunks were emitted for this change. Use a file-level comment to review it.";
    }
    files.push(currentFile);
    currentFile = undefined;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      finishFile();
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (!match) continue;
      const oldPath = unquoteGitPath(match[1]!);
      const newPath = unquoteGitPath(match[2]!);
      currentFile = {
        filePath: newPath,
        displayPath: newPath,
        oldPath,
        newPath,
        status: "modified",
        additions: 0,
        deletions: 0,
        hunks: [],
      };
      continue;
    }

    if (!currentFile) continue;

    if (line.startsWith("new file mode ")) {
      currentFile.status = "added";
      continue;
    }

    if (line.startsWith("deleted file mode ")) {
      currentFile.status = "deleted";
      currentFile.filePath = currentFile.oldPath;
      currentFile.displayPath = currentFile.oldPath;
      continue;
    }

    if (line.startsWith("rename from ")) {
      currentFile.status = "renamed";
      currentFile.oldPath = unquoteGitPath(line.slice("rename from ".length));
      currentFile.filePath = currentFile.newPath;
      currentFile.displayPath = `${currentFile.oldPath} → ${currentFile.newPath}`;
      continue;
    }

    if (line.startsWith("rename to ")) {
      currentFile.status = "renamed";
      currentFile.newPath = unquoteGitPath(line.slice("rename to ".length));
      currentFile.filePath = currentFile.newPath;
      currentFile.displayPath = `${currentFile.oldPath} → ${currentFile.newPath}`;
      continue;
    }

    if (line.startsWith("Binary files ")) {
      currentFile.note = "Binary file changed. Use a file-level comment to review it.";
      continue;
    }

    if (line.startsWith("@@ ")) {
      finishHunk();
      const parsed = parseHunkHeader(line);
      if (!parsed) continue;
      currentHunk = parsed;
      oldLine = parsed.oldStart;
      newLine = parsed.newStart;
      continue;
    }

    if (!currentHunk) continue;
    if (line === "\\ No newline at end of file") continue;

    const prefix = line[0];
    const text = line.slice(1);

    if (prefix === " ") {
      currentHunk.lines.push({
        kind: "context",
        text,
        oldLineNumber: oldLine,
        newLineNumber: newLine,
      });
      oldLine++;
      newLine++;
      continue;
    }

    if (prefix === "+") {
      currentFile.additions++;
      currentHunk.lines.push({ kind: "add", text, newLineNumber: newLine });
      newLine++;
      continue;
    }

    if (prefix === "-") {
      currentFile.deletions++;
      currentHunk.lines.push({ kind: "del", text, oldLineNumber: oldLine });
      oldLine++;
    }
  }

  finishFile();
  return files;
}
