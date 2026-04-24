import type { DiffFile, DiffHunk, DiffLine, PersistedReviewState, ReviewSelectionAnchor, ReviewSnapshot, ReviewThreadTarget, ReviewUIState } from "./types.js";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function createEmptyState(): PersistedReviewState {
  return {
    version: 1,
    defaultBranch: undefined,
    baseRef: undefined,
    nextThreadId: 1,
    selection: {},
    threads: [],
    pendingDispatches: [],
  };
}

export function createUIState(): ReviewUIState {
  return {
    selectedFileIndex: 0,
    selectedHunkIndex: 0,
    selectedLineIndex: 0,
    showHelp: false,
    wrapDiff: false,
  };
}

export function lineMatchesAnchor(line: DiffLine, anchor: ReviewSelectionAnchor | ReviewThreadTarget): boolean {
  if (anchor.newLineNumber !== undefined && line.newLineNumber === anchor.newLineNumber) {
    return anchor.lineText ? anchor.lineText === line.text : true;
  }
  if (anchor.oldLineNumber !== undefined && line.oldLineNumber === anchor.oldLineNumber) {
    return anchor.lineText ? anchor.lineText === line.text : true;
  }
  return anchor.lineText ? anchor.lineText === line.text : false;
}

export function applySelectionToSnapshot(snapshot: ReviewSnapshot | undefined, uiState: ReviewUIState, selection: ReviewSelectionAnchor) {
  if (!snapshot || snapshot.files.length === 0) {
    uiState.selectedFileIndex = 0;
    uiState.selectedHunkIndex = 0;
    uiState.selectedLineIndex = 0;
    return;
  }

  const fileIndex = selection.filePath
    ? snapshot.files.findIndex((file) => file.filePath === selection.filePath)
    : -1;
  uiState.selectedFileIndex = clamp(fileIndex >= 0 ? fileIndex : uiState.selectedFileIndex, 0, snapshot.files.length - 1);

  const file = snapshot.files[uiState.selectedFileIndex]!;
  if (file.hunks.length === 0) {
    uiState.selectedHunkIndex = 0;
    uiState.selectedLineIndex = 0;
    return;
  }

  const hunkIndex = selection.hunkHeader ? file.hunks.findIndex((hunk) => hunk.header === selection.hunkHeader) : -1;
  uiState.selectedHunkIndex = clamp(hunkIndex >= 0 ? hunkIndex : uiState.selectedHunkIndex, 0, file.hunks.length - 1);

  const hunk = file.hunks[uiState.selectedHunkIndex]!;
  const lineIndex = hunk.lines.findIndex((line) => lineMatchesAnchor(line, selection));
  uiState.selectedLineIndex = clamp(lineIndex >= 0 ? lineIndex : uiState.selectedLineIndex, 0, Math.max(0, hunk.lines.length - 1));
}

export function clampSelectionToSnapshot(snapshot: ReviewSnapshot | undefined, uiState: ReviewUIState) {
  applySelectionToSnapshot(snapshot, uiState, {});
}

export function currentFile(snapshot: ReviewSnapshot | undefined, uiState: ReviewUIState): DiffFile | undefined {
  if (!snapshot || snapshot.files.length === 0) return undefined;
  return snapshot.files[clamp(uiState.selectedFileIndex, 0, snapshot.files.length - 1)];
}

export function currentHunk(snapshot: ReviewSnapshot | undefined, uiState: ReviewUIState): DiffHunk | undefined {
  const file = currentFile(snapshot, uiState);
  if (!file || file.hunks.length === 0) return undefined;
  return file.hunks[clamp(uiState.selectedHunkIndex, 0, file.hunks.length - 1)];
}

export function currentLine(snapshot: ReviewSnapshot | undefined, uiState: ReviewUIState): DiffLine | undefined {
  const hunk = currentHunk(snapshot, uiState);
  if (!hunk || hunk.lines.length === 0) return undefined;
  return hunk.lines[clamp(uiState.selectedLineIndex, 0, hunk.lines.length - 1)];
}

export function captureSelection(snapshot: ReviewSnapshot | undefined, uiState: ReviewUIState): ReviewSelectionAnchor {
  const file = currentFile(snapshot, uiState);
  const hunk = currentHunk(snapshot, uiState);
  const line = currentLine(snapshot, uiState);

  return {
    filePath: file?.filePath,
    hunkHeader: hunk?.header,
    oldLineNumber: line?.oldLineNumber,
    newLineNumber: line?.newLineNumber,
    lineText: line?.text,
  };
}
