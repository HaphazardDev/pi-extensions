export type ThreadTargetKind = "file" | "hunk" | "line";
export type ThreadState = "queued" | "submitted" | "responded";
export type ThreadCommentKind = "comment" | "question";
export type ThreadResponseStatus = "answered" | "changed" | "needs-follow-up";
export type FileStatus = "modified" | "added" | "deleted" | "renamed";
export type DiffLineKind = "context" | "add" | "del";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface DiffFile {
  filePath: string;
  displayPath: string;
  oldPath: string;
  newPath: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  note?: string;
}

export interface ReviewSnapshot {
  baseRef: string;
  defaultBranch: string;
  files: DiffFile[];
}

export interface ReviewSelectionAnchor {
  filePath?: string;
  hunkHeader?: string;
  oldLineNumber?: number;
  newLineNumber?: number;
  lineText?: string;
}

export interface ReviewThreadTarget {
  kind: ThreadTargetKind;
  hunkHeader?: string;
  oldLineNumber?: number;
  newLineNumber?: number;
  lineText?: string;
}

export interface ReviewThread {
  id: string;
  filePath: string;
  displayPath: string;
  target: ReviewThreadTarget;
  excerpt: string;
  comment: string;
  commentKind: ThreadCommentKind;
  dispatchMode: "batch" | "immediate";
  state: ThreadState;
  responseStatus?: ThreadResponseStatus;
  responseText?: string;
  createdAt: number;
  submittedAt?: number;
  respondedAt?: number;
  lastDispatchId?: string;
}

export interface PendingDispatch {
  id: string;
  threadIds: string[];
  createdAt: number;
  baseRef: string;
}

export interface PersistedReviewState {
  version: 1;
  defaultBranch?: string;
  baseRef?: string;
  nextThreadId: number;
  selection: ReviewSelectionAnchor;
  threads: ReviewThread[];
  pendingDispatches: PendingDispatch[];
}

export interface ReviewUIState {
  selectedFileIndex: number;
  selectedHunkIndex: number;
  selectedLineIndex: number;
  showHelp: boolean;
  wrapDiff: boolean;
}

export interface SearchTargetMatch {
  score: number;
  positions: number[];
}

export interface FileJumpMatch {
  score: number;
  labelPositions: number[];
  descriptionPositions: number[];
}

export interface DiffSearchMatch {
  hunkIndex: number;
  lineIndex: number;
  positions: number[];
}

export interface FileJumpItem {
  value: string;
  fileIndex: number;
  rawLabel: string;
  rawDescription: string;
  file: DiffFile;
}

export type ReviewAction =
  | { type: "close" }
  | { type: "refresh" }
  | { type: "saved-thread" }
  | { type: "send-batch" }
  | { type: "dispatch-threads"; threadIds: string[] }
  | { type: "delete-thread"; visibleThreadIds: string[] };

export interface ParsedThreadResponse {
  status: ThreadResponseStatus;
  responseText: string;
}
