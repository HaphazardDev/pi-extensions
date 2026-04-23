import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
} from "@mariozechner/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, SelectList, type SelectItem, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";

const REVIEW_STATE_TYPE = "interactive-code-review-state";
const STATUS_KEY = "interactive-code-review";
const DEFAULT_VISIBLE_DIFF_LINES = 18;
const DEFAULT_TERMINAL_ROWS = 24;
const RESERVED_TOP_CONTEXT_ROWS = 4;
const VIEWPORT_SAFETY_ROWS = 3;
const LINE_CONTEXT_RADIUS = 3;
const MAX_HUNK_EXCERPT_LINES = 24;
const RESPONSE_BLOCK_PATTERN = /\[\[thread:([^\]]+)\]\]([\s\S]*?)(?=\n\[\[thread:|$)/g;

type ThreadTargetKind = "file" | "hunk" | "line";
type ThreadState = "queued" | "submitted" | "responded";
type ThreadCommentKind = "comment" | "question";
type ThreadResponseStatus = "answered" | "changed" | "needs-follow-up";
type FileStatus = "modified" | "added" | "deleted" | "renamed";
type DiffLineKind = "context" | "add" | "del";

interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

interface DiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

interface DiffFile {
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

interface ReviewSnapshot {
  baseRef: string;
  defaultBranch: string;
  files: DiffFile[];
}

interface ReviewSelectionAnchor {
  filePath?: string;
  hunkHeader?: string;
  oldLineNumber?: number;
  newLineNumber?: number;
  lineText?: string;
}

interface ReviewThreadTarget {
  kind: ThreadTargetKind;
  hunkHeader?: string;
  oldLineNumber?: number;
  newLineNumber?: number;
  lineText?: string;
}

interface ReviewThread {
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

interface PendingDispatch {
  id: string;
  threadIds: string[];
  createdAt: number;
  baseRef: string;
}

interface PersistedReviewState {
  version: 1;
  defaultBranch?: string;
  baseRef?: string;
  nextThreadId: number;
  selection: ReviewSelectionAnchor;
  threads: ReviewThread[];
  pendingDispatches: PendingDispatch[];
}

interface ReviewUIState {
  selectedFileIndex: number;
  selectedHunkIndex: number;
  selectedLineIndex: number;
  showHelp: boolean;
  wrapDiff: boolean;
}

interface FileJumpItem {
  value: string;
  fileIndex: number;
  rawLabel: string;
  rawDescription: string;
  file: DiffFile;
}

interface SearchTargetMatch {
  score: number;
  positions: number[];
}

interface FileJumpMatch {
  score: number;
  labelPositions: number[];
  descriptionPositions: number[];
}

interface DiffSearchMatch {
  hunkIndex: number;
  lineIndex: number;
  positions: number[];
}

type ReviewAction =
  | { type: "close" }
  | { type: "refresh" }
  | { type: "saved-thread" }
  | { type: "send-batch" }
  | { type: "dispatch-threads"; threadIds: string[] }
  | { type: "delete-thread"; visibleThreadIds: string[] };

interface ParsedThreadResponse {
  status: ThreadResponseStatus;
  responseText: string;
}

function createEmptyState(): PersistedReviewState {
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

function createUIState(): ReviewUIState {
  return {
    selectedFileIndex: 0,
    selectedHunkIndex: 0,
    selectedLineIndex: 0,
    showHelp: false,
    wrapDiff: false,
  };
}

function isTextContent(content: unknown): content is { type: "text"; text: string } {
  return !!content && typeof content === "object" && (content as { type?: string }).type === "text";
}

function getMessageText(message: { content?: unknown[] } | undefined): string {
  if (!message?.content || !Array.isArray(message.content)) return "";
  return message.content.filter(isTextContent).map((part) => part.text).join("\n").trim();
}

function getLastAssistantText(messages: Array<{ role?: string; content?: unknown[] }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "assistant") continue;
    const text = getMessageText(message);
    if (text.length > 0) return text;
  }
  return "";
}

function unquoteGitPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) return trimmed;
  return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

function formatCount(label: string, count: number): string {
  return `${count} ${label}${count === 1 ? "" : "s"}`;
}

function formatQueuedThreadCount(count: number): string {
  return formatCount("queued thread", count);
}

function formatAwaitingReplyCount(count: number): string {
  return `${count} awaiting ${count === 1 ? "reply" : "replies"}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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

function parseGitDiff(rawDiff: string): DiffFile[] {
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

function lineLabel(line: DiffLine): string {
  if (line.newLineNumber !== undefined) return `L${line.newLineNumber}`;
  if (line.oldLineNumber !== undefined) return `old L${line.oldLineNumber}`;
  return "line";
}

function lineMatchesAnchor(line: DiffLine, anchor: ReviewSelectionAnchor | ReviewThreadTarget): boolean {
  if (anchor.newLineNumber !== undefined && line.newLineNumber === anchor.newLineNumber) {
    return anchor.lineText ? anchor.lineText === line.text : true;
  }
  if (anchor.oldLineNumber !== undefined && line.oldLineNumber === anchor.oldLineNumber) {
    return anchor.lineText ? anchor.lineText === line.text : true;
  }
  return anchor.lineText ? anchor.lineText === line.text : false;
}

function applySelectionToSnapshot(snapshot: ReviewSnapshot | undefined, uiState: ReviewUIState, selection: ReviewSelectionAnchor) {
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

function clampSelectionToSnapshot(snapshot: ReviewSnapshot | undefined, uiState: ReviewUIState) {
  applySelectionToSnapshot(snapshot, uiState, {});
}

function currentFile(snapshot: ReviewSnapshot | undefined, uiState: ReviewUIState): DiffFile | undefined {
  if (!snapshot || snapshot.files.length === 0) return undefined;
  return snapshot.files[clamp(uiState.selectedFileIndex, 0, snapshot.files.length - 1)];
}

function currentHunk(snapshot: ReviewSnapshot | undefined, uiState: ReviewUIState): DiffHunk | undefined {
  const file = currentFile(snapshot, uiState);
  if (!file || file.hunks.length === 0) return undefined;
  return file.hunks[clamp(uiState.selectedHunkIndex, 0, file.hunks.length - 1)];
}

function currentLine(snapshot: ReviewSnapshot | undefined, uiState: ReviewUIState): DiffLine | undefined {
  const hunk = currentHunk(snapshot, uiState);
  if (!hunk || hunk.lines.length === 0) return undefined;
  return hunk.lines[clamp(uiState.selectedLineIndex, 0, hunk.lines.length - 1)];
}

function captureSelection(snapshot: ReviewSnapshot | undefined, uiState: ReviewUIState): ReviewSelectionAnchor {
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

function threadStatusText(thread: ReviewThread): string {
  if (thread.state === "queued") return "queued";
  if (thread.state === "submitted") return "awaiting response";
  switch (thread.responseStatus) {
    case "changed":
      return "changed";
    case "needs-follow-up":
      return "needs follow-up";
    default:
      return "answered";
  }
}

function threadStatusColor(thread: ReviewThread): "accent" | "warning" | "success" | "muted" {
  if (thread.state === "queued") return "accent";
  if (thread.state === "submitted") return "warning";
  if (thread.responseStatus === "needs-follow-up") return "warning";
  if (thread.responseStatus === "changed") return "success";
  return "muted";
}

function threadLocationLabel(thread: ReviewThread): string {
  if (thread.target.kind === "file") return "file";
  if (thread.target.kind === "hunk") return thread.target.hunkHeader ?? "hunk";
  if (thread.target.newLineNumber !== undefined) return `L${thread.target.newLineNumber}`;
  if (thread.target.oldLineNumber !== undefined) return `old L${thread.target.oldLineNumber}`;
  return "line";
}

function countQueuedThreads(state: PersistedReviewState): number {
  return state.threads.filter((thread) => thread.state === "queued").length;
}

function countAwaitingThreads(state: PersistedReviewState): number {
  return state.threads.filter((thread) => thread.state === "submitted").length;
}

function formatReviewStatus(theme: ExtensionContext["ui"]["theme"], state: PersistedReviewState): string | undefined {
  const queued = countQueuedThreads(state);
  const awaiting = countAwaitingThreads(state);
  if (queued === 0 && awaiting === 0) return undefined;

  const segments: string[] = [theme.fg("accent", "review")];
  if (queued > 0) segments.push(theme.fg("accent", formatQueuedThreadCount(queued)));
  if (awaiting > 0) segments.push(theme.fg("warning", formatAwaitingReplyCount(awaiting)));
  return `🧵 ${segments.join(" • ")}`;
}

function matchingThreadScore(
  thread: ReviewThread,
  file: DiffFile | undefined,
  hunk: DiffHunk | undefined,
  line: DiffLine | undefined,
): number {
  if (!file || thread.filePath !== file.filePath) return 0;
  if (thread.target.kind === "file") return 1;
  if (thread.target.kind === "hunk") {
    if (!hunk) return 0;
    return thread.target.hunkHeader === hunk.header ? 2 : 0;
  }
  if (!line) return 0;
  if (!lineMatchesAnchor(line, thread.target)) return 0;
  return hunk && thread.target.hunkHeader === hunk.header ? 3 : 2;
}

function getThreadsForCurrentView(
  state: PersistedReviewState,
  file: DiffFile | undefined,
  hunk: DiffHunk | undefined,
  line: DiffLine | undefined,
): ReviewThread[] {
  return state.threads
    .map((thread) => ({ thread, score: matchingThreadScore(thread, file, hunk, line) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.thread.createdAt - a.thread.createdAt)
    .map((entry) => entry.thread);
}

function countThreadsForLine(state: PersistedReviewState, file: DiffFile, hunk: DiffHunk, line: DiffLine): number {
  return state.threads.filter((thread) => matchingThreadScore(thread, file, hunk, line) === 3).length;
}

function countThreadsForHunk(state: PersistedReviewState, file: DiffFile, hunk: DiffHunk): number {
  return state.threads.filter((thread) => matchingThreadScore(thread, file, hunk, undefined) >= 2).length;
}

function countThreadsForFile(state: PersistedReviewState, file: DiffFile): number {
  return state.threads.filter((thread) => matchingThreadScore(thread, file, undefined, undefined) >= 1).length;
}

function renderWrapped(text: string, width: number, lines: string[], indent = "") {
  const wrapped = wrapTextWithAnsi(text, Math.max(10, width - indent.length));
  for (const line of wrapped) {
    lines.push(truncateToWidth(`${indent}${line}`, width));
  }
}

function inferCommentKind(text: string): ThreadCommentKind {
  const trimmed = text.trim();
  return trimmed.endsWith("?") || /\?\s*$/m.test(trimmed) ? "question" : "comment";
}

function formatThreadPrompt(thread: ReviewThread): string {
  return [
    `Thread ID: ${thread.id}`,
    `File: ${thread.displayPath}`,
    `Target: ${threadLocationLabel(thread)}`,
    `Reviewer ${thread.commentKind}:`,
    thread.comment,
    "Diff excerpt:",
    "```diff",
    thread.excerpt,
    "```",
  ].join("\n");
}

function buildDispatchPrompt(baseRef: string, threads: ReviewThread[]): string {
  const promptParts = [
    `Please address the following interactive code review thread${threads.length === 1 ? "" : "s"} against ${baseRef}.`,
    "",
    "For each thread:",
    "- inspect any code you need",
    "- make code changes when they are warranted",
    "- if the reviewer is asking a question that does not require a code change, answer it directly",
    "- after all tool use, finish with exactly one response block per thread using this format:",
    "",
    "[[thread:<id>]]",
    "Status: answered|changed|needs-follow-up",
    "Response:",
    "<your response>",
    "",
    "Do not omit any thread ids.",
    "",
  ];

  for (const thread of threads) {
    promptParts.push(formatThreadPrompt(thread), "");
  }

  return promptParts.join("\n").trim();
}

function parseThreadResponses(text: string): Map<string, ParsedThreadResponse> {
  const responses = new Map<string, ParsedThreadResponse>();
  RESPONSE_BLOCK_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null = RESPONSE_BLOCK_PATTERN.exec(text);

  while (match) {
    const threadId = match[1]!.trim();
    const block = match[2]!.trim();
    const statusMatch = /^Status:\s*(answered|changed|needs-follow-up)\s*$/im.exec(block);
    const status = (statusMatch?.[1] ?? "answered") as ThreadResponseStatus;
    let responseText = block.replace(/^Status:.*$/im, "").replace(/^Response:\s*$/im, "").trim();
    if (responseText.length === 0) responseText = block.trim();
    responses.set(threadId, { status, responseText });
    match = RESPONSE_BLOCK_PATTERN.exec(text);
  }

  return responses;
}

function buildLineExcerpt(hunk: DiffHunk, lineIndex: number): string {
  const start = Math.max(0, lineIndex - LINE_CONTEXT_RADIUS);
  const end = Math.min(hunk.lines.length, lineIndex + LINE_CONTEXT_RADIUS + 1);
  return hunk.lines
    .slice(start, end)
    .map((line) => `${line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}${line.text}`)
    .join("\n");
}

function buildHunkExcerpt(hunk: DiffHunk): string {
  const lines = hunk.lines.slice(0, MAX_HUNK_EXCERPT_LINES).map((line) => {
    const prefix = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
    return `${prefix}${line.text}`;
  });
  if (hunk.lines.length > MAX_HUNK_EXCERPT_LINES) lines.push("... (hunk truncated)");
  return [hunk.header, ...lines].join("\n");
}

function buildFileExcerpt(file: DiffFile): string {
  if (file.hunks.length === 0) return file.note ?? `${file.displayPath} changed.`;
  const selectedHunks = file.hunks.slice(0, 2).map((hunk) => buildHunkExcerpt(hunk));
  return selectedHunks.join("\n\n");
}

function createEditorTheme(theme: Theme): EditorTheme {
  return {
    borderColor: (s) => theme.fg("accent", s),
    selectList: {
      selectedPrefix: (t) => theme.fg("accent", t),
      selectedText: (t) => theme.fg("accent", t),
      description: (t) => theme.fg("muted", t),
      scrollInfo: (t) => theme.fg("dim", t),
      noMatch: (t) => theme.fg("warning", t),
    },
  };
}

function formatFileChangeSummary(file: DiffFile): string {
  return `+${file.additions} -${file.deletions} • ${file.status}`;
}

function formatFileJumpDescription(file: DiffFile, state: PersistedReviewState): string {
  const parts = [formatFileChangeSummary(file)];
  if (file.hunks.length > 0) parts.push(formatCount("hunk", file.hunks.length));
  else if (file.note) parts.push("no text hunks");

  const threadCount = countThreadsForFile(state, file);
  if (threadCount > 0) parts.push(formatCount("thread", threadCount));
  return parts.join(" • ");
}

function isPrintableCharacter(data: string): boolean {
  return data.length === 1 && data.charCodeAt(0) >= 32 && data !== "\x7f";
}

function isHelpToggleKey(data: string): boolean {
  return data === "?" || matchesKey(data, Key.f1) || matchesKey(data, Key.alt("h"));
}

function isTextInputHelpToggleKey(data: string): boolean {
  return matchesKey(data, Key.f1) || matchesKey(data, Key.alt("h"));
}

function basenameFromPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;
}

function contiguousPositions(start: number, length: number): number[] {
  return Array.from({ length }, (_, index) => start + index);
}

function fuzzySubsequenceMatch(query: string, target: string): SearchTargetMatch | null {
  if (query.length === 0) return { score: 0, positions: [] };

  let queryIndex = 0;
  let score = 0;
  let lastMatchIndex = -1;
  const positions: number[] = [];

  for (let i = 0; i < target.length && queryIndex < query.length; i++) {
    if (target[i] !== query[queryIndex]) continue;

    score += 10;
    if (i === 0 || "/._- ".includes(target[i - 1] ?? "")) score += 18;
    if (lastMatchIndex === i - 1) score += 14;
    else if (lastMatchIndex >= 0) score -= Math.min(6, i - lastMatchIndex - 1);

    positions.push(i);
    lastMatchIndex = i;
    queryIndex++;
  }

  if (queryIndex !== query.length) return null;
  score -= Math.max(0, target.length - query.length);
  return { score: 140 + score, positions };
}

function matchSearchTarget(query: string, target: string): SearchTargetMatch | null {
  if (query.length === 0) return { score: 0, positions: [] };
  if (target.length === 0) return null;

  if (target === query) return { score: 600 - target.length, positions: contiguousPositions(0, query.length) };
  if (target.startsWith(query)) return { score: 450 - Math.max(0, target.length - query.length), positions: contiguousPositions(0, query.length) };

  const substringIndex = target.indexOf(query);
  if (substringIndex >= 0) {
    const boundaryBonus = substringIndex === 0 || "/._- ".includes(target[substringIndex - 1] ?? "") ? 40 : 0;
    return {
      score: 320 + boundaryBonus - substringIndex,
      positions: contiguousPositions(substringIndex, query.length),
    };
  }

  return fuzzySubsequenceMatch(query, target);
}

function remapPositionsToDisplay(source: string, display: string, positions: number[], preferLast = false): number[] {
  if (positions.length === 0) return [];
  const sourceIndex = preferLast ? display.lastIndexOf(source) : display.indexOf(source);
  if (sourceIndex < 0) return [];
  return positions.map((position) => sourceIndex + position).filter((position) => position >= 0 && position < display.length);
}

function uniqueSortedPositions(positions: Iterable<number>): number[] {
  return Array.from(new Set(positions)).sort((a, b) => a - b);
}

function highlightMatchedCharacters(text: string, positions: number[], theme: Theme): string {
  if (positions.length === 0) return text;

  const highlighted = new Set(positions);
  let output = "";
  let current = "";
  let currentHighlighted = false;

  const flush = () => {
    if (!current) return;
    output += currentHighlighted ? theme.fg("warning", theme.bold(current)) : current;
    current = "";
  };

  for (let i = 0; i < text.length; i++) {
    const nextHighlighted = highlighted.has(i);
    if (current.length > 0 && nextHighlighted !== currentHighlighted) flush();
    currentHighlighted = nextHighlighted;
    current += text[i];
  }

  flush();
  return output;
}

function findSubstringMatchPositions(text: string, query: string): number[][] {
  if (!query) return [];

  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const matches: number[][] = [];
  let searchIndex = 0;

  while (searchIndex <= lowerText.length - lowerQuery.length) {
    const matchIndex = lowerText.indexOf(lowerQuery, searchIndex);
    if (matchIndex < 0) break;
    matches.push(contiguousPositions(matchIndex, lowerQuery.length));
    searchIndex = matchIndex + Math.max(1, lowerQuery.length);
  }

  return matches;
}

function findDiffSearchMatches(file: DiffFile | undefined, query: string): DiffSearchMatch[] {
  if (!file || !query.trim()) return [];

  const matches: DiffSearchMatch[] = [];
  file.hunks.forEach((hunk, hunkIndex) => {
    hunk.lines.forEach((line, lineIndex) => {
      for (const positions of findSubstringMatchPositions(line.text, query.trim())) {
        matches.push({ hunkIndex, lineIndex, positions });
      }
    });
  });

  return matches;
}

function scoreFileJumpMatch(query: string, file: DiffFile): FileJumpMatch | null {
  const terms = query.toLowerCase().split(/\s+/).filter((term) => term.length > 0);
  if (terms.length === 0) {
    return { score: 0, labelPositions: [], descriptionPositions: [] };
  }

  const basename = basenameFromPath(file.filePath).toLowerCase();
  const displayPath = file.displayPath.toLowerCase();
  const labelPositions: number[] = [];

  let totalScore = 0;
  for (const term of terms) {
    const match = matchSearchTarget(term, basename);
    if (match === null) return null;

    totalScore += match.score;
    labelPositions.push(...remapPositionsToDisplay(basename, displayPath, match.positions, true));
  }

  totalScore -= Math.max(0, basename.length - query.replace(/\s+/g, "").length);
  return {
    score: totalScore,
    labelPositions: uniqueSortedPositions(labelPositions),
    descriptionPositions: [],
  };
}

function ensureFileSelected(snapshot: ReviewSnapshot | undefined, uiState: ReviewUIState) {
  clampSelectionToSnapshot(snapshot, uiState);
}

class ReviewBrowserComponent {
  private cachedWidth?: number;
  private cachedLines?: string[];
  private readonly editor: Editor;
  private readonly filterEditor: Editor;
  private readonly searchEditor: Editor;
  private fileSelectList: SelectList;
  private readonly allFileJumpItems: FileJumpItem[] = [];
  private readonly fileIndexByValue = new Map<string, number>();
  private composeMode: "browse" | "compose" | "jump" | "search" = "browse";
  private draftTarget?: ThreadTargetKind;
  private editingThreadId?: string;
  private draftDispatchMode: "batch" | "immediate" = "batch";
  private searchQuery = "";
  private searchMatchIndex = 0;
  private lastVisibleDiffLineCount = DEFAULT_VISIBLE_DIFF_LINES;
  private _focused = false;

  private refresh(): void {
    this.invalidate();
    this.tui.requestRender();
  }

  private syncFocusedEditors(): void {
    this.editor.focused = this._focused && this.composeMode === "compose";
    this.filterEditor.focused = this._focused && this.composeMode === "jump";
    this.searchEditor.focused = this._focused && this.composeMode === "search";
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.syncFocusedEditors();
  }

  constructor(
    private readonly tui: any,
    private readonly state: PersistedReviewState,
    private readonly uiState: ReviewUIState,
    private readonly snapshot: ReviewSnapshot,
    private readonly theme: Theme,
    private readonly done: (action: ReviewAction) => void,
  ) {
    const editorTheme = createEditorTheme(this.theme);
    this.editor = new Editor(tui, editorTheme);
    this.editor.onSubmit = (value) => {
      this.submitDraft(value);
    };

    this.filterEditor = new Editor(tui, editorTheme);
    this.filterEditor.onSubmit = () => {
      this.jumpToSelectedFile();
    };

    this.searchEditor = new Editor(tui, editorTheme);
    this.searchEditor.onSubmit = () => {
      this.acceptDiffSearch();
    };

    this.allFileJumpItems = this.snapshot.files.map((file, index) => {
      const value = `${index}:${file.filePath}`;
      this.fileIndexByValue.set(value, index);
      return {
        value,
        fileIndex: index,
        rawLabel: file.displayPath,
        rawDescription: formatFileJumpDescription(file, this.state),
        file,
      };
    });

    this.fileSelectList = this.createFileSelectList(this.allFileJumpItems.map((item) => ({
      value: item.value,
      label: item.rawLabel,
      description: item.rawDescription,
    })));
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.editor.invalidate();
    this.filterEditor.invalidate();
    this.searchEditor.invalidate();
    this.fileSelectList.invalidate();
  }

  handleInput(data: string): void {
    if (this.composeMode === "compose") {
      this.handleComposeInput(data);
      return;
    }

    if (this.composeMode === "jump") {
      this.handleJumpInput(data);
      return;
    }

    if (this.composeMode === "search") {
      this.handleSearchInput(data);
      return;
    }

    const file = currentFile(this.snapshot, this.uiState);
    const hunk = currentHunk(this.snapshot, this.uiState);

    if (matchesKey(data, Key.escape) || data === "q") {
      this.done({ type: "close" });
      return;
    }

    if (isHelpToggleKey(data)) {
      this.uiState.showHelp = !this.uiState.showHelp;
      this.refresh();
      return;
    }

    if (data === "w") {
      this.uiState.wrapDiff = !this.uiState.wrapDiff;
      this.refresh();
      return;
    }

    if (data === "/") {
      this.startDiffSearch();
      return;
    }

    if (data === "g") {
      this.startFileJump();
      return;
    }

    if (this.searchQuery && data === "n") {
      this.moveSearchMatch(1);
      this.refresh();
      return;
    }

    if (this.searchQuery && data === "N") {
      this.moveSearchMatch(-1);
      this.refresh();
      return;
    }

    if (matchesKey(data, Key.tab) || data === "n") {
      this.moveFile(1);
      return;
    }

    if (matchesKey(data, Key.shift("tab")) || data === "p") {
      this.moveFile(-1);
      return;
    }

    if (data === "]") {
      this.moveHunk(1);
      return;
    }

    if (data === "[") {
      this.moveHunk(-1);
      return;
    }

    if (matchesKey(data, Key.down) || data === "j") {
      this.moveLine(1);
      return;
    }

    if (matchesKey(data, Key.up) || data === "k") {
      this.moveLine(-1);
      return;
    }

    if (data === "d" || matchesKey(data, Key.ctrl("d"))) {
      this.moveHalfPage(1);
      return;
    }

    if (data === "u" || matchesKey(data, Key.ctrl("u"))) {
      this.moveHalfPage(-1);
      return;
    }

    if (data === "c" && file && hunk) {
      this.startComposeForNewThread("line");
      return;
    }

    if (data === "H" && file) {
      this.startComposeForNewThread("hunk");
      return;
    }

    if (data === "F" && file) {
      this.startComposeForNewThread("file");
      return;
    }

    if (data === "e") {
      const firstThread = this.getVisibleThreads()[0];
      if (firstThread) this.startComposeForExistingThread(firstThread);
      return;
    }

    if (/^[1-4]$/.test(data)) {
      const thread = this.getVisibleThreads()[Number(data) - 1];
      if (thread) this.startComposeForExistingThread(thread);
      return;
    }

    if (data === "x" || matchesKey(data, Key.backspace)) {
      const visibleThreadIds = this.getVisibleThreads().map((thread) => thread.id);
      if (visibleThreadIds.length > 0) {
        this.done({ type: "delete-thread", visibleThreadIds });
      }
      return;
    }

    if (data === "s") {
      this.done({ type: "send-batch" });
      return;
    }

    if (data === "r") {
      this.done({ type: "refresh" });
    }
  }

  private handleComposeInput(data: string) {
    if (matchesKey(data, Key.escape)) {
      this.cancelCompose();
      return;
    }

    if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
      this.draftDispatchMode = this.draftDispatchMode === "batch" ? "immediate" : "batch";
      this.refresh();
      return;
    }

    if (isTextInputHelpToggleKey(data)) {
      this.uiState.showHelp = !this.uiState.showHelp;
      this.refresh();
      return;
    }

    this.editor.handleInput(data);
    this.refresh();
  }

  private handleJumpInput(data: string) {
    if (matchesKey(data, Key.escape)) {
      this.cancelFileJump();
      return;
    }

    if (isTextInputHelpToggleKey(data)) {
      this.uiState.showHelp = !this.uiState.showHelp;
      this.refresh();
      return;
    }

    if (matchesKey(data, Key.shift("enter")) || matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
      return;
    }

    if (matchesKey(data, Key.enter)) {
      this.jumpToSelectedFile();
      return;
    }

    if (matchesKey(data, Key.down) || matchesKey(data, Key.ctrl("n"))) {
      this.fileSelectList.handleInput("\x1b[B");
      this.refresh();
      return;
    }

    if (matchesKey(data, Key.up) || matchesKey(data, Key.ctrl("p"))) {
      this.fileSelectList.handleInput("\x1b[A");
      this.refresh();
      return;
    }

    if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.pageUp)) {
      this.fileSelectList.handleInput(data);
      this.refresh();
      return;
    }

    this.filterEditor.handleInput(data);
    this.updateFileJumpFilter();
    this.refresh();
  }

  private handleSearchInput(data: string) {
    if (matchesKey(data, Key.escape)) {
      this.setSearchQueryFromEditor(false);
      this.closeDiffSearch();
      return;
    }

    if (isTextInputHelpToggleKey(data)) {
      this.uiState.showHelp = !this.uiState.showHelp;
      this.refresh();
      return;
    }

    if (matchesKey(data, Key.shift("enter")) || matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
      return;
    }

    if (matchesKey(data, Key.enter)) {
      this.acceptDiffSearch();
      return;
    }

    if (matchesKey(data, Key.down) || matchesKey(data, Key.ctrl("n"))) {
      this.moveSearchMatch(1);
      this.refresh();
      return;
    }

    if (matchesKey(data, Key.up) || matchesKey(data, Key.ctrl("p"))) {
      this.moveSearchMatch(-1);
      this.refresh();
      return;
    }

    this.searchEditor.handleInput(data);
    this.setSearchQueryFromEditor();
    this.refresh();
  }

  private createFileSelectList(items: SelectItem[], selectedValue?: string): SelectList {
    const list = new SelectList(items, Math.min(Math.max(this.snapshot.files.length, 1), 8), createEditorTheme(this.theme).selectList, {
      minPrimaryColumnWidth: 24,
      maxPrimaryColumnWidth: 80,
    });

    if (selectedValue) {
      const selectedIndex = items.findIndex((item) => item.value === selectedValue);
      if (selectedIndex >= 0) list.setSelectedIndex(selectedIndex);
    }

    return list;
  }

  private updateFileJumpFilter() {
    const filter = this.filterEditor.getText().trim();

    const filteredItems = filter.length === 0
      ? this.allFileJumpItems.map((item) => ({
          value: item.value,
          label: item.rawLabel,
          description: item.rawDescription,
        }))
      : this.allFileJumpItems
          .map((item): { value: string; label: string; description: string; score: number; basename: string; filePath: string } | null => {
            const match = scoreFileJumpMatch(filter, item.file);
            if (match === null) return null;

            return {
              value: item.value,
              label: highlightMatchedCharacters(item.rawLabel, match.labelPositions, this.theme),
              description: highlightMatchedCharacters(item.rawDescription, match.descriptionPositions, this.theme),
              score: match.score,
              basename: basenameFromPath(item.file.filePath).toLowerCase(),
              filePath: item.file.filePath.toLowerCase(),
            };
          })
          .filter((entry): entry is { value: string; label: string; description: string; score: number; basename: string; filePath: string } => entry !== null)
          .sort((a, b) => b.score - a.score || a.basename.localeCompare(b.basename) || a.filePath.localeCompare(b.filePath))
          .map(({ value, label, description }) => ({ value, label, description }));

    this.fileSelectList = this.createFileSelectList(filteredItems);
  }

  private getCurrentSearchMatches(): DiffSearchMatch[] {
    return findDiffSearchMatches(currentFile(this.snapshot, this.uiState), this.searchQuery);
  }

  private setSearchQueryFromEditor(resetIndex = true) {
    this.searchQuery = this.searchEditor.getText().trim();
    if (resetIndex) this.searchMatchIndex = 0;
  }

  private getCurrentSearchMatch(): DiffSearchMatch | undefined {
    const matches = this.getCurrentSearchMatches();
    if (matches.length === 0) return undefined;
    this.searchMatchIndex = clamp(this.searchMatchIndex, 0, matches.length - 1);
    return matches[this.searchMatchIndex];
  }

  private moveSearchMatch(delta: number) {
    const matches = this.getCurrentSearchMatches();
    if (matches.length === 0) return;
    this.searchMatchIndex = (this.searchMatchIndex + delta + matches.length) % matches.length;
    this.jumpToCurrentSearchMatch();
  }

  private jumpToCurrentSearchMatch(): boolean {
    const matches = this.getCurrentSearchMatches();
    if (matches.length === 0) return false;

    this.searchMatchIndex = clamp(this.searchMatchIndex, 0, matches.length - 1);
    const match = matches[this.searchMatchIndex]!;
    this.uiState.selectedHunkIndex = match.hunkIndex;
    this.uiState.selectedLineIndex = match.lineIndex;
    return true;
  }

  private startDiffSearch() {
    this.composeMode = "search";
    this.searchEditor.setText(this.searchQuery);
    this.syncFocusedEditors();
    this.refresh();
  }

  private closeDiffSearch() {
    this.composeMode = "browse";
    this.searchEditor.setText(this.searchQuery);
    this.syncFocusedEditors();
    this.refresh();
  }

  private acceptDiffSearch() {
    this.setSearchQueryFromEditor(false);
    this.jumpToCurrentSearchMatch();
    this.closeDiffSearch();
  }

  private renderSearchHighlightedText(
    text: string,
    positions: number[][],
    activeMatchIndex: number | undefined,
    color: Parameters<Theme["fg"]>[0],
  ): string {
    if (positions.length === 0) return this.theme.fg(color, text);

    const allPositions = new Set<number>();
    positions.forEach((matchPositions) => matchPositions.forEach((position) => allPositions.add(position)));
    const activePositions = activeMatchIndex === undefined ? new Set<number>() : new Set(positions[activeMatchIndex] ?? []);

    let output = "";
    let current = "";
    let state: "normal" | "match" | "active" = "normal";

    const flush = () => {
      if (!current) return;
      if (state === "active") output += this.theme.fg("accent", this.theme.bold(current));
      else if (state === "match") output += this.theme.fg("warning", this.theme.bold(current));
      else output += this.theme.fg(color, current);
      current = "";
    };

    for (let i = 0; i < text.length; i++) {
      const nextState = activePositions.has(i) ? "active" : allPositions.has(i) ? "match" : "normal";
      if (current.length > 0 && nextState !== state) flush();
      state = nextState;
      current += text[i];
    }

    flush();
    return output;
  }

  private getSearchLineMatches(file: DiffFile | undefined): Map<string, { positions: number[][]; activeMatchIndex?: number }> {
    const lineMatches = new Map<string, { positions: number[][]; activeMatchIndex?: number }>();
    if (!file || !this.searchQuery) return lineMatches;

    const matches = this.getCurrentSearchMatches();
    const activeMatch = matches.length === 0 ? undefined : matches[clamp(this.searchMatchIndex, 0, matches.length - 1)];

    matches.forEach((match) => {
      const key = `${match.hunkIndex}:${match.lineIndex}`;
      const entry = lineMatches.get(key) ?? { positions: [] };
      if (activeMatch === match) entry.activeMatchIndex = entry.positions.length;
      entry.positions.push(match.positions);
      lineMatches.set(key, entry);
    });

    return lineMatches;
  }

  private cancelCompose() {
    this.composeMode = "browse";
    this.draftTarget = undefined;
    this.editingThreadId = undefined;
    this.draftDispatchMode = "batch";
    this.editor.setText("");
    this.syncFocusedEditors();
    this.refresh();
  }

  private startComposeForNewThread(target: ThreadTargetKind) {
    const file = currentFile(this.snapshot, this.uiState);
    const hunk = currentHunk(this.snapshot, this.uiState);
    const line = currentLine(this.snapshot, this.uiState);

    if (!file) return;
    if (target === "line" && (!hunk || !line)) return;
    if (target === "hunk" && !hunk) return;

    this.composeMode = "compose";
    this.draftTarget = target;
    this.editingThreadId = undefined;
    this.draftDispatchMode = "batch";
    this.editor.setText("");
    this.syncFocusedEditors();
    this.refresh();
  }

  private startComposeForExistingThread(thread: ReviewThread) {
    this.composeMode = "compose";
    this.draftTarget = thread.target.kind;
    this.editingThreadId = thread.id;
    this.draftDispatchMode = thread.dispatchMode;
    this.editor.setText(thread.comment);
    this.syncFocusedEditors();
    this.refresh();
  }

  private startFileJump() {
    if (this.snapshot.files.length === 0) return;
    this.composeMode = "jump";
    this.filterEditor.setText("");
    this.fileSelectList = this.createFileSelectList(
      this.allFileJumpItems.map((item) => ({ value: item.value, label: item.rawLabel, description: item.rawDescription })),
      this.allFileJumpItems[clamp(this.uiState.selectedFileIndex, 0, this.snapshot.files.length - 1)]?.value,
    );
    this.syncFocusedEditors();
    this.refresh();
  }

  private cancelFileJump() {
    this.composeMode = "browse";
    this.filterEditor.setText("");
    this.fileSelectList = this.createFileSelectList(this.allFileJumpItems.map((item) => ({ value: item.value, label: item.rawLabel, description: item.rawDescription })));
    this.syncFocusedEditors();
    this.refresh();
  }

  private jumpToSelectedFile() {
    const selected = this.fileSelectList.getSelectedItem();
    if (!selected) {
      this.refresh();
      return;
    }

    const nextFileIndex = this.fileIndexByValue.get(selected.value);
    if (nextFileIndex === undefined) {
      this.refresh();
      return;
    }

    this.uiState.selectedFileIndex = nextFileIndex;
    this.uiState.selectedHunkIndex = 0;
    this.uiState.selectedLineIndex = 0;
    this.cancelFileJump();
  }

  private submitDraft(submittedValue?: string) {
    const trimmedComment = (submittedValue ?? this.editor.getText()).trim();
    if (!trimmedComment) {
      this.cancelCompose();
      return;
    }

    const thread = this.editingThreadId
      ? this.updateExistingThread(this.editingThreadId, trimmedComment)
      : this.createThreadFromSelection(trimmedComment);

    if (!thread) {
      this.cancelCompose();
      return;
    }

    const dispatchMode = this.draftDispatchMode;
    this.cancelCompose();

    if (dispatchMode === "immediate") {
      this.done({ type: "dispatch-threads", threadIds: [thread.id] });
      return;
    }

    this.done({ type: "saved-thread" });
  }

  private updateExistingThread(threadId: string, comment: string): ReviewThread | null {
    const thread = this.state.threads.find((candidate) => candidate.id === threadId);
    if (!thread) return null;

    thread.comment = comment;
    thread.commentKind = inferCommentKind(comment);
    thread.dispatchMode = this.draftDispatchMode;
    thread.state = "queued";
    thread.responseStatus = undefined;
    thread.responseText = undefined;
    thread.submittedAt = undefined;
    thread.respondedAt = undefined;
    thread.lastDispatchId = undefined;
    return thread;
  }

  private createThreadFromSelection(comment: string): ReviewThread | null {
    const file = currentFile(this.snapshot, this.uiState);
    if (!file || !this.draftTarget) return null;

    const hunk = currentHunk(this.snapshot, this.uiState);
    const line = currentLine(this.snapshot, this.uiState);

    if (this.draftTarget === "line" && (!hunk || !line)) return null;
    if (this.draftTarget === "hunk" && !hunk) return null;

    const excerpt =
      this.draftTarget === "file"
        ? buildFileExcerpt(file)
        : this.draftTarget === "hunk"
          ? buildHunkExcerpt(hunk!)
          : buildLineExcerpt(hunk!, this.uiState.selectedLineIndex);

    const now = Date.now();
    const thread: ReviewThread = {
      id: `review-${this.state.nextThreadId++}`,
      filePath: file.filePath,
      displayPath: file.displayPath,
      target:
        this.draftTarget === "file"
          ? { kind: "file" }
          : this.draftTarget === "hunk"
            ? { kind: "hunk", hunkHeader: hunk?.header }
            : {
                kind: "line",
                hunkHeader: hunk?.header,
                oldLineNumber: line?.oldLineNumber,
                newLineNumber: line?.newLineNumber,
                lineText: line?.text,
              },
      excerpt,
      comment,
      commentKind: inferCommentKind(comment),
      dispatchMode: this.draftDispatchMode,
      state: "queued",
      createdAt: now,
    };

    this.state.threads.push(thread);
    return thread;
  }

  private getVisibleThreads(): ReviewThread[] {
    const file = currentFile(this.snapshot, this.uiState);
    const hunk = currentHunk(this.snapshot, this.uiState);
    const line = currentLine(this.snapshot, this.uiState);
    return getThreadsForCurrentView(this.state, file, hunk, line).slice(0, 4);
  }

  private moveFile(delta: number) {
    if (this.snapshot.files.length === 0) return;
    this.uiState.selectedFileIndex = clamp(this.uiState.selectedFileIndex + delta, 0, this.snapshot.files.length - 1);
    this.uiState.selectedHunkIndex = 0;
    this.uiState.selectedLineIndex = 0;
    this.refresh();
  }

  private selectHunk(hunkIndex: number, linePosition: "start" | "end" = "start"): boolean {
    const file = currentFile(this.snapshot, this.uiState);
    if (!file || file.hunks.length === 0) return false;

    const nextHunkIndex = clamp(hunkIndex, 0, file.hunks.length - 1);
    const nextHunk = file.hunks[nextHunkIndex]!;
    this.uiState.selectedHunkIndex = nextHunkIndex;
    this.uiState.selectedLineIndex = linePosition === "end" ? Math.max(0, nextHunk.lines.length - 1) : 0;
    return true;
  }

  private findFileWithHunks(startFileIndex: number, delta: -1 | 1): number | undefined {
    for (let fileIndex = startFileIndex + delta; fileIndex >= 0 && fileIndex < this.snapshot.files.length; fileIndex += delta) {
      if ((this.snapshot.files[fileIndex]?.hunks.length ?? 0) > 0) return fileIndex;
    }
    return undefined;
  }

  private moveHunk(delta: number) {
    const file = currentFile(this.snapshot, this.uiState);
    if (!file || file.hunks.length === 0 || delta === 0) return;

    const fileIndex = clamp(this.uiState.selectedFileIndex, 0, this.snapshot.files.length - 1);
    const nextHunkIndex = this.uiState.selectedHunkIndex + delta;
    if (nextHunkIndex >= 0 && nextHunkIndex < file.hunks.length) {
      this.selectHunk(nextHunkIndex, "start");
      this.refresh();
      return;
    }

    const nextFileIndex = this.findFileWithHunks(fileIndex, delta > 0 ? 1 : -1);
    if (nextFileIndex === undefined) return;

    this.uiState.selectedFileIndex = nextFileIndex;
    const targetFile = this.snapshot.files[nextFileIndex]!;
    const targetHunkIndex = delta > 0 ? 0 : Math.max(0, targetFile.hunks.length - 1);
    this.selectHunk(targetHunkIndex, "start");
    this.refresh();
  }

  private moveLine(delta: number) {
    const file = currentFile(this.snapshot, this.uiState);
    if (!file || file.hunks.length === 0 || delta === 0) return;

    let fileIndex = clamp(this.uiState.selectedFileIndex, 0, this.snapshot.files.length - 1);
    let hunkIndex = clamp(this.uiState.selectedHunkIndex, 0, file.hunks.length - 1);
    let hunk = file.hunks[hunkIndex]!;
    let lineIndex = clamp(this.uiState.selectedLineIndex, 0, Math.max(0, hunk.lines.length - 1));
    let remaining = delta;

    while (remaining !== 0) {
      const currentFileEntry = this.snapshot.files[fileIndex]!;
      hunk = currentFileEntry.hunks[hunkIndex]!;
      const maxLineIndex = Math.max(0, hunk.lines.length - 1);

      if (remaining > 0) {
        if (lineIndex < maxLineIndex) {
          const step = Math.min(remaining, maxLineIndex - lineIndex);
          lineIndex += step;
          remaining -= step;
          continue;
        }

        if (hunkIndex < currentFileEntry.hunks.length - 1) {
          hunkIndex += 1;
          lineIndex = 0;
          remaining -= 1;
          continue;
        }

        const nextFileIndex = this.findFileWithHunks(fileIndex, 1);
        if (nextFileIndex === undefined) break;
        fileIndex = nextFileIndex;
        hunkIndex = 0;
        lineIndex = 0;
        remaining -= 1;
        continue;
      }

      if (lineIndex > 0) {
        const step = Math.min(-remaining, lineIndex);
        lineIndex -= step;
        remaining += step;
        continue;
      }

      if (hunkIndex > 0) {
        hunkIndex -= 1;
        lineIndex = Math.max(0, this.snapshot.files[fileIndex]!.hunks[hunkIndex]!.lines.length - 1);
        remaining += 1;
        continue;
      }

      const previousFileIndex = this.findFileWithHunks(fileIndex, -1);
      if (previousFileIndex === undefined) break;
      fileIndex = previousFileIndex;
      const previousFile = this.snapshot.files[fileIndex]!;
      hunkIndex = Math.max(0, previousFile.hunks.length - 1);
      lineIndex = Math.max(0, previousFile.hunks[hunkIndex]!.lines.length - 1);
      remaining += 1;
    }

    this.uiState.selectedFileIndex = fileIndex;
    this.uiState.selectedHunkIndex = hunkIndex;
    this.uiState.selectedLineIndex = lineIndex;
    this.refresh();
  }

  private moveHalfPage(delta: number) {
    const halfPage = Math.max(1, Math.floor(this.lastVisibleDiffLineCount / 2));
    this.moveLine(delta * halfPage);
  }

  private getTerminalRows(): number {
    const rows = this.tui?.terminal?.rows;
    return typeof rows === "number" && rows > 0 ? rows : DEFAULT_TERMINAL_ROWS;
  }

  private estimateDiffLineHeight(width: number, oldWidth: number, newWidth: number, diffLine: DiffLine): number {
    if (!this.uiState.wrapDiff) return 1;

    const prefix = diffLine.kind === "add" ? "+" : diffLine.kind === "del" ? "-" : " ";
    const color = diffLine.kind === "add" ? "toolDiffAdded" : diffLine.kind === "del" ? "toolDiffRemoved" : "toolDiffContext";
    const oldCell = `${diffLine.oldLineNumber ?? ""}`.padStart(oldWidth, " ");
    const newCell = `${diffLine.newLineNumber ?? ""}`.padStart(newWidth, " ");
    const linePrefix = ` > ${this.theme.fg("dim", oldCell)} ${this.theme.fg("dim", newCell)} ${this.theme.fg("dim", "│")} `;
    const contentWidth = Math.max(1, width - visibleWidth(linePrefix));
    return Math.max(1, wrapTextWithAnsi(this.theme.fg(color, `${prefix}${diffLine.text}`), contentWidth).length);
  }

  private computeVisibleDiffWindow(hunk: DiffHunk, width: number, oldWidth: number, newWidth: number, budgetRows: number): { start: number; end: number } {
    if (hunk.lines.length === 0) return { start: 0, end: 0 };

    const selectedIndex = clamp(this.uiState.selectedLineIndex, 0, hunk.lines.length - 1);
    const lineHeights = hunk.lines.map((diffLine) => this.estimateDiffLineHeight(width, oldWidth, newWidth, diffLine));
    // Don't force a minimum diff height here: when comments/editor/help grow, doing so can push
    // the overall review UI taller than the terminal viewport.
    const maxRows = Math.max(1, budgetRows);

    let start = selectedIndex;
    let end = selectedIndex + 1;
    let usedRows = lineHeights[selectedIndex] ?? 1;

    const totalRows = (nextStart: number, nextEnd: number, rowsUsed: number) => {
      return (nextStart > 0 ? 1 : 0) + rowsUsed + (nextEnd < hunk.lines.length ? 1 : 0);
    };

    while (true) {
      const distanceAbove = selectedIndex - start;
      const distanceBelow = end - 1 - selectedIndex;
      const directions = distanceAbove <= distanceBelow ? (["up", "down"] as const) : (["down", "up"] as const);
      let expanded = false;

      for (const direction of directions) {
        if (direction === "up" && start > 0) {
          const nextStart = start - 1;
          const nextUsedRows = usedRows + (lineHeights[nextStart] ?? 1);
          if (totalRows(nextStart, end, nextUsedRows) <= maxRows) {
            start = nextStart;
            usedRows = nextUsedRows;
            expanded = true;
            break;
          }
        }

        if (direction === "down" && end < hunk.lines.length) {
          const nextEnd = end + 1;
          const nextUsedRows = usedRows + (lineHeights[end] ?? 1);
          if (totalRows(start, nextEnd, nextUsedRows) <= maxRows) {
            end = nextEnd;
            usedRows = nextUsedRows;
            expanded = true;
            break;
          }
        }
      }

      if (!expanded) break;
    }

    return { start, end };
  }

  private renderDiffLine(
    lines: string[],
    width: number,
    oldWidth: number,
    newWidth: number,
    diffLine: DiffLine,
    isSelected: boolean,
    lineThreads: number,
    searchLineMatch?: { positions: number[][]; activeMatchIndex?: number },
  ) {
    const theme = this.theme;
    const marker = lineThreads > 0 ? theme.fg("warning", "●") : theme.fg("dim", "·");
    const pointer = isSelected ? theme.fg("accent", ">") : " ";
    const oldCell = `${diffLine.oldLineNumber ?? ""}`.padStart(oldWidth, " ");
    const newCell = `${diffLine.newLineNumber ?? ""}`.padStart(newWidth, " ");
    const blankOldCell = " ".repeat(oldWidth);
    const blankNewCell = " ".repeat(newWidth);
    const prefix = diffLine.kind === "add" ? "+" : diffLine.kind === "del" ? "-" : " ";
    const color = diffLine.kind === "add" ? "toolDiffAdded" : diffLine.kind === "del" ? "toolDiffRemoved" : "toolDiffContext";
    const highlightedText = this.renderSearchHighlightedText(
      `${prefix}${diffLine.text}`,
      (searchLineMatch?.positions ?? []).map((positions) => positions.map((position) => position + 1)),
      searchLineMatch?.activeMatchIndex,
      color,
    );
    const linePrefix = `${pointer}${marker} ${theme.fg("dim", oldCell)} ${theme.fg("dim", newCell)} ${theme.fg("dim", "│")} `;

    if (!this.uiState.wrapDiff) {
      const raw = `${linePrefix}${highlightedText}`;
      const rendered = truncateToWidth(raw, width);
      lines.push(isSelected ? theme.bg("selectedBg", rendered) : rendered);
      return;
    }

    const continuationPrefix = `  ${theme.fg("dim", blankOldCell)} ${theme.fg("dim", blankNewCell)} ${theme.fg("dim", "│")} `;
    const contentWidth = Math.max(1, width - visibleWidth(linePrefix));
    const wrapped = wrapTextWithAnsi(highlightedText, contentWidth);

    wrapped.forEach((segment, index) => {
      const rendered = truncateToWidth(`${index === 0 ? linePrefix : continuationPrefix}${segment}`, width, "");
      lines.push(isSelected ? theme.bg("selectedBg", rendered) : rendered);
    });
  }

  private buildAdjacentNavigationIndicator(width: number, direction: "up" | "down"): string | undefined {
    const fileIndex = clamp(this.uiState.selectedFileIndex, 0, this.snapshot.files.length - 1);
    const file = this.snapshot.files[fileIndex];
    if (!file || file.hunks.length === 0) return undefined;

    const currentHunkIndex = clamp(this.uiState.selectedHunkIndex, 0, file.hunks.length - 1);
    const targetHunkIndex = direction === "up" ? currentHunkIndex - 1 : currentHunkIndex + 1;
    const theme = this.theme;

    if (targetHunkIndex >= 0 && targetHunkIndex < file.hunks.length) {
      const targetHunk = file.hunks[targetHunkIndex]!;
      const remainingHunks = direction === "up" ? currentHunkIndex : file.hunks.length - currentHunkIndex - 1;
      const keyHint = direction === "up" ? "[ prev hunk" : "] next hunk";
      const location = direction === "up" ? "above" : "below";
      const parts = [
        theme.fg("accent", direction === "up" ? "↑" : "↓"),
        theme.fg("accent", `${remainingHunks} ${remainingHunks === 1 ? "hunk" : "hunks"} ${location}`),
        theme.fg("muted", keyHint),
        theme.fg("muted", targetHunk.header),
      ];

      const threadCount = countThreadsForHunk(this.state, file, targetHunk);
      if (threadCount > 0) parts.push(theme.fg("warning", formatCount("thread", threadCount)));

      return truncateToWidth(parts.join(theme.fg("dim", " • ")), width);
    }

    const targetFileIndex = this.findFileWithHunks(fileIndex, direction === "up" ? -1 : 1);
    if (targetFileIndex === undefined) return undefined;

    const targetFile = this.snapshot.files[targetFileIndex]!;
    const targetFileHunkIndex = direction === "up" ? Math.max(0, targetFile.hunks.length - 1) : 0;
    const parts = [
      theme.fg("accent", direction === "up" ? "↑" : "↓"),
      theme.fg("accent", direction === "up" ? "previous file" : "next file"),
      theme.fg("muted", direction === "up" ? "[ prev hunk" : "] next hunk"),
      theme.fg("text", `[${targetFileIndex + 1}/${this.snapshot.files.length}] ${targetFile.displayPath}`),
      theme.fg("muted", `Hunk ${targetFileHunkIndex + 1}/${targetFile.hunks.length}`),
    ];

    const threadCount = countThreadsForFile(this.state, targetFile);
    if (threadCount > 0) parts.push(theme.fg("warning", formatCount("thread", threadCount)));

    return truncateToWidth(parts.join(theme.fg("dim", " • ")), width);
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

    const lines: string[] = [];
    const theme = this.theme;
    const file = currentFile(this.snapshot, this.uiState);
    const hunk = currentHunk(this.snapshot, this.uiState);
    const line = currentLine(this.snapshot, this.uiState);
    const queued = countQueuedThreads(this.state);
    const awaiting = countAwaitingThreads(this.state);

    const headerParts = [
      theme.fg("accent", theme.bold("Review")),
      theme.fg("muted", `against ${this.snapshot.baseRef}`),
      theme.fg("muted", `${this.snapshot.files.length} ${this.snapshot.files.length === 1 ? "file" : "files"}`),
      theme.fg(this.uiState.wrapDiff ? "accent" : "dim", `wrap ${this.uiState.wrapDiff ? "on" : "off"}`),
    ];
    if (queued > 0) headerParts.push(theme.fg("accent", formatQueuedThreadCount(queued)));
    if (awaiting > 0) headerParts.push(theme.fg("warning", formatAwaitingReplyCount(awaiting)));
    lines.push(truncateToWidth(headerParts.join(theme.fg("dim", " • ")), width));

    if (!file) {
      lines.push("");
      renderWrapped(theme.fg("muted", "No changes found against the selected base ref."), width, lines);
      renderWrapped(theme.fg("dim", "Press r to refresh or Esc to close."), width, lines);
      lines.push(truncateToWidth(theme.fg("accent", "─".repeat(width)), width));
      this.cachedWidth = width;
      this.cachedLines = lines;
      return lines;
    }

    lines.push("");
    const fileHeader = `${theme.fg("accent", `[${this.uiState.selectedFileIndex + 1}/${this.snapshot.files.length}]`)} ${theme.fg("text", file.displayPath)} ${theme.fg(
      "muted",
      `(${formatFileChangeSummary(file)})`,
    )}`;
    lines.push(truncateToWidth(fileHeader, width));

    if (!hunk) {
      lines.push("");
      renderWrapped(theme.fg("muted", file.note ?? "This change has no textual hunks."), width, lines);
      lines.push("");
      const jumpSectionLines = this.buildJumpSectionLines(width);
      const searchSectionLines = this.buildSearchSectionLines(width);
      const modalSectionLines = jumpSectionLines.length > 0 ? jumpSectionLines : searchSectionLines;
      const threadSectionLines = modalSectionLines.length > 0 ? [] : this.buildThreadSectionLines(width, file, undefined, undefined);
      const composerLines = modalSectionLines.length > 0 ? [] : this.buildComposerLines(width, file, undefined, undefined);
      lines.push(...modalSectionLines);
      lines.push(...threadSectionLines);
      lines.push(...composerLines);
      lines.push(...this.buildFooterLines(width));
      this.cachedWidth = width;
      this.cachedLines = lines;
      return lines;
    }

    lines.push("");
    const currentHunkIndex = clamp(this.uiState.selectedHunkIndex, 0, file.hunks.length - 1);
    const hunkThreadCount = countThreadsForHunk(this.state, file, hunk);
    const hunkHeaderParts = [theme.fg("accent", `Hunk ${currentHunkIndex + 1}/${file.hunks.length}`), theme.fg("muted", hunk.header)];
    if (hunkThreadCount > 0) hunkHeaderParts.push(theme.fg("warning", formatCount("thread", hunkThreadCount)));
    lines.push(truncateToWidth(hunkHeaderParts.join(theme.fg("dim", " • ")), width));

    const oldWidth = Math.max(3, String(Math.max(hunk.oldStart + hunk.oldLines, 0)).length);
    const newWidth = Math.max(3, String(Math.max(hunk.newStart + hunk.newLines, 0)).length);
    const jumpSectionLines = this.buildJumpSectionLines(width);
    const searchSectionLines = this.buildSearchSectionLines(width);
    const modalSectionLines = jumpSectionLines.length > 0 ? jumpSectionLines : searchSectionLines;
    const threadSectionLines = modalSectionLines.length > 0 ? [] : this.buildThreadSectionLines(width, file, hunk, line);
    const composerLines = modalSectionLines.length > 0 ? [] : this.buildComposerLines(width, file, hunk, line);
    const footerLines = this.buildFooterLines(width);
    const searchLineMatches = this.getSearchLineMatches(file);
    const previousHunkIndicator = this.buildAdjacentNavigationIndicator(width, "up");
    const nextHunkIndicator = this.buildAdjacentNavigationIndicator(width, "down");
    // Keep most of the top context visible and leave a small safety margin for pi's own chrome/footer.
    const visibleTopRows = Math.min(lines.length, RESERVED_TOP_CONTEXT_ROWS);
    const reservedRows =
      visibleTopRows +
      1 +
      (previousHunkIndicator ? 1 : 0) +
      (nextHunkIndicator ? 1 : 0) +
      modalSectionLines.length +
      threadSectionLines.length +
      composerLines.length +
      footerLines.length +
      VIEWPORT_SAFETY_ROWS;
    const availableDiffRows = this.getTerminalRows() - reservedRows;
    const { start: windowStart, end: windowEnd } = this.computeVisibleDiffWindow(hunk, width, oldWidth, newWidth, availableDiffRows);

    this.lastVisibleDiffLineCount = Math.max(1, windowEnd - windowStart);

    if (previousHunkIndicator) lines.push(previousHunkIndicator);

    if (windowStart > 0) {
      lines.push(truncateToWidth(theme.fg("dim", `… ${windowStart} earlier line${windowStart === 1 ? "" : "s"}`), width));
    }

    for (let i = windowStart; i < windowEnd; i++) {
      const diffLine = hunk.lines[i]!;
      const isSelected = i === this.uiState.selectedLineIndex;
      const lineThreads = countThreadsForLine(this.state, file, hunk, diffLine);
      const searchLineMatch = searchLineMatches.get(`${currentHunkIndex}:${i}`);
      this.renderDiffLine(lines, width, oldWidth, newWidth, diffLine, isSelected, lineThreads, searchLineMatch);
    }

    if (windowEnd < hunk.lines.length) {
      const remaining = hunk.lines.length - windowEnd;
      lines.push(truncateToWidth(theme.fg("dim", `… ${remaining} more line${remaining === 1 ? "" : "s"}`), width));
    }

    if (nextHunkIndicator) lines.push(nextHunkIndicator);

    lines.push("");
    lines.push(...modalSectionLines);
    lines.push(...threadSectionLines);
    lines.push(...composerLines);
    lines.push(...footerLines);

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  private buildThreadSectionLines(width: number, file: DiffFile, hunk: DiffHunk | undefined, line: DiffLine | undefined): string[] {
    const lines: string[] = [];
    const theme = this.theme;
    const threads = getThreadsForCurrentView(this.state, file, hunk, line).slice(0, 4);

    lines.push(truncateToWidth(theme.fg("accent", threads.length === 0 ? "Comments" : `Comments (${threads.length})`), width));
    if (threads.length === 0) {
      lines.push(truncateToWidth(theme.fg("dim", "None for this line, hunk, or file."), width));
      lines.push("");
      return lines;
    }

    threads.forEach((thread, index) => {
      const header = `${theme.fg("accent", `[${index + 1}]`)} ${theme.fg(threadStatusColor(thread), threadStatusText(thread))} ${theme.fg("muted", `(${threadLocationLabel(thread)})`)}`;
      renderWrapped(header, width, lines);
      renderWrapped(`${theme.fg("text", thread.comment)}`, width, lines, "  ");
      if (thread.responseText) {
        renderWrapped(`${theme.fg("muted", "↳ ")}${theme.fg("muted", thread.responseText)}`, width, lines, "  ");
      }
      lines.push("");
    });

    lines.push("");
    return lines;
  }

  private buildJumpSectionLines(width: number): string[] {
    if (this.composeMode !== "jump") return [];

    const lines: string[] = [];
    const theme = this.theme;

    this.syncFocusedEditors();
    lines.push(truncateToWidth(theme.fg("accent", "Files"), width));
    lines.push("");

    for (const editorLine of this.filterEditor.render(Math.max(20, width - 2))) {
      lines.push(truncateToWidth(` ${editorLine}`, width));
    }

    lines.push("");
    lines.push(...this.fileSelectList.render(width));
    lines.push("");
    return lines;
  }

  private buildSearchSectionLines(width: number): string[] {
    if (this.composeMode !== "search") return [];

    const lines: string[] = [];
    const theme = this.theme;
    const matches = this.getCurrentSearchMatches();
    const currentMatchNumber = matches.length === 0 ? 0 : clamp(this.searchMatchIndex, 0, matches.length - 1) + 1;
    const countText =
      matches.length === 0
        ? theme.fg("warning", "No matches")
        : theme.fg("muted", `${currentMatchNumber}/${matches.length} matches`);

    this.syncFocusedEditors();
    lines.push(truncateToWidth(theme.fg("accent", "Search"), width));
    lines.push("");

    for (const editorLine of this.searchEditor.render(Math.max(20, width - 2))) {
      lines.push(truncateToWidth(` ${editorLine}`, width));
    }

    lines.push("");
    lines.push(truncateToWidth(countText, width));
    lines.push("");
    return lines;
  }

  private buildComposerLines(width: number, file: DiffFile, hunk: DiffHunk | undefined, line: DiffLine | undefined): string[] {
    if (this.composeMode !== "compose") return [];

    const lines: string[] = [];
    this.syncFocusedEditors();
    lines.push(truncateToWidth(this.theme.fg("accent", this.editingThreadId ? "Edit comment" : "Comment draft"), width));

    const location = this.editingThreadId
      ? (() => {
          const thread = this.state.threads.find((candidate) => candidate.id === this.editingThreadId);
          return thread ? `${thread.displayPath} • ${threadLocationLabel(thread)}` : file.displayPath;
        })()
      : this.draftTarget === "file"
        ? file.displayPath
        : this.draftTarget === "hunk"
          ? `${file.displayPath} • ${hunk?.header ?? "hunk"}`
          : `${file.displayPath} • ${line ? lineLabel(line) : "line"}`;

    renderWrapped(this.theme.fg("muted", location), width, lines);

    const modeText =
      this.draftDispatchMode === "batch"
        ? `${this.theme.fg("accent", "batch")} • ${this.theme.fg("dim", "immediate")}`
        : `${this.theme.fg("dim", "batch")} • ${this.theme.fg("accent", "immediate")}`;
    renderWrapped(`${this.theme.fg("muted", "Send mode: ")}${modeText}`, width, lines);

    if (this.editingThreadId) {
      renderWrapped(this.theme.fg("warning", "Editing requeues this thread."), width, lines);
    }

    lines.push("");
    for (const editorLine of this.editor.render(Math.max(20, width - 2))) {
      lines.push(truncateToWidth(` ${editorLine}`, width));
    }
    lines.push("");
    return lines;
  }

  private buildFooterLines(width: number): string[] {
    const lines: string[] = [];
    const theme = this.theme;

    if (!this.uiState.showHelp) {
      const hiddenHelpLabel =
        this.composeMode === "browse"
          ? "? help"
          : this.composeMode === "jump"
            ? "Alt+H help"
            : "Alt+H help";
      lines.push(truncateToWidth(theme.fg("dim", hiddenHelpLabel), width));
      return lines;
    }

    lines.push(truncateToWidth(theme.fg("accent", "Controls"), width));

    if (this.composeMode === "compose") {
      renderWrapped(theme.fg("dim", "Edit: Enter save • Shift+Enter newline"), width, lines);
      renderWrapped(theme.fg("dim", "Mode: Tab batch/immediate • Esc cancel • F1 or Alt+H toggle controls"), width, lines);
      return lines;
    }

    if (this.composeMode === "jump") {
      renderWrapped(theme.fg("dim", "Files: type to search • ↑/↓ or Ctrl+N/Ctrl+P move selection • Enter open • Esc cancel"), width, lines);
      renderWrapped(theme.fg("dim", "F1 or Alt+H toggle controls"), width, lines);
      return lines;
    }

    if (this.composeMode === "search") {
      renderWrapped(theme.fg("dim", "Search: type to search this file diff • ↑/↓ or Ctrl+N/Ctrl+P move selection • Enter jump • Esc close"), width, lines);
      renderWrapped(theme.fg("dim", "After closing, n / N move between matches • F1 or Alt+H toggle controls"), width, lines);
      return lines;
    }

    renderWrapped(
      theme.fg("dim", "Move: Tab/Shift+Tab file • [/] hunk (crosses files) • ↑/↓ or j/k line (crosses hunks/files) • d/u or Ctrl+D/Ctrl+U half-page"),
      width,
      lines,
    );
    renderWrapped(
      theme.fg(
        "dim",
        `View: w wrap ${this.uiState.wrapDiff ? "off" : "on"} • / search diff • g files${this.searchQuery ? " • n/N search matches" : ""} • ? hide controls`,
      ),
      width,
      lines,
    );
    renderWrapped(
      theme.fg(
        "dim",
        "Act: c line comment • H hunk comment • F file comment • e or 1-4 edit • x/Backspace delete • s send • r refresh • Esc/q close",
      ),
      width,
      lines,
    );
    return lines;
  }
}

export default function interactiveCodeReview(pi: ExtensionAPI) {
  let state = createEmptyState();
  const uiState = createUIState();
  let snapshot: ReviewSnapshot | undefined;

  const persistState = () => {
    state.selection = captureSelection(snapshot, uiState);
    pi.appendEntry(REVIEW_STATE_TYPE, state);
  };

  const updateStatus = (ctx: ExtensionContext | ExtensionCommandContext) => {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(STATUS_KEY, formatReviewStatus(ctx.ui.theme, state));
  };

  const loadState = (ctx: ExtensionContext) => {
    state = createEmptyState();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === REVIEW_STATE_TYPE) {
        const data = entry.data as PersistedReviewState | undefined;
        if (data?.version === 1) state = data;
      }
    }
    snapshot = undefined;
    applySelectionToSnapshot(snapshot, uiState, state.selection);
    updateStatus(ctx);
  };

  const execGit = async (args: string[]) => {
    const result = await pi.exec("git", args);
    return result;
  };

  const tryGit = async (args: string[]): Promise<string | undefined> => {
    const result = await execGit(args);
    if (result.code !== 0) return undefined;
    const text = result.stdout.trim();
    return text.length > 0 ? text : undefined;
  };

  const resolveDefaultBranch = async (): Promise<string> => {
    const remoteHead = await tryGit(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
    if (remoteHead) return remoteHead;

    const remoteMain = await tryGit(["rev-parse", "--verify", "refs/remotes/origin/main"]);
    if (remoteMain) return "origin/main";

    const remoteMaster = await tryGit(["rev-parse", "--verify", "refs/remotes/origin/master"]);
    if (remoteMaster) return "origin/master";

    const localMain = await tryGit(["rev-parse", "--verify", "main"]);
    if (localMain) return "main";

    const localMaster = await tryGit(["rev-parse", "--verify", "master"]);
    if (localMaster) return "master";

    throw new Error("Could not determine a default branch. Try /review <base-ref>.");
  };

  const getUntrackedPaths = async (): Promise<string[]> => {
    const result = await execGit(["ls-files", "--others", "--exclude-standard", "-z"]);
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || "Failed to list untracked files.");
    }

    return result.stdout
      .split("\0")
      .map((path) => path.trim())
      .filter((path) => path.length > 0);
  };

  const buildUntrackedDiff = async (path: string): Promise<string> => {
    const result = await execGit(["diff", "--no-index", "--unified=3", "--no-color", "/dev/null", path]);
    if (result.code !== 0 && result.code !== 1) {
      throw new Error(result.stderr.trim() || `Failed to diff untracked file ${path}.`);
    }
    return result.stdout;
  };

  const buildSnapshot = async (requestedBaseRef?: string): Promise<ReviewSnapshot> => {
    const defaultBranch = state.defaultBranch || (requestedBaseRef?.trim() ? undefined : await resolveDefaultBranch());
    const baseRef = requestedBaseRef?.trim() || state.baseRef || state.defaultBranch || defaultBranch;
    if (!baseRef) {
      throw new Error("Could not determine a review base. Try /review <base-ref>.");
    }
    const verify = await execGit(["rev-parse", "--verify", baseRef]);
    if (verify.code !== 0) {
      const reason = verify.stderr.trim() || `Unable to resolve ${baseRef}`;
      throw new Error(reason);
    }

    const mergeBase = await execGit(["merge-base", baseRef, "HEAD"]);
    if (mergeBase.code !== 0) {
      throw new Error(mergeBase.stderr.trim() || `Unable to compute merge-base for ${baseRef} and HEAD`);
    }

    const mergeBaseSha = mergeBase.stdout.trim();
    const trackedDiff = await execGit(["diff", "--unified=3", "--no-color", "--find-renames", mergeBaseSha]);
    if (trackedDiff.code !== 0) {
      throw new Error(trackedDiff.stderr.trim() || `git diff failed for ${mergeBaseSha}`);
    }

    const untrackedPaths = await getUntrackedPaths();
    const untrackedDiffs: string[] = [];
    for (const path of untrackedPaths) {
      untrackedDiffs.push(await buildUntrackedDiff(path));
    }

    const combinedDiff = [trackedDiff.stdout, ...untrackedDiffs].filter((chunk) => chunk.trim().length > 0).join("\n");
    const files = parseGitDiff(combinedDiff);
    return { baseRef, defaultBranch: defaultBranch ?? baseRef, files };
  };

  const dispatchThreads = async (threads: ReviewThread[], ctx: ExtensionCommandContext) => {
    if (threads.length === 0) {
      ctx.ui.notify("There are no review threads to send.", "warning");
      return false;
    }

    const dispatchId = `dispatch-${Date.now()}`;
    const now = Date.now();
    for (const thread of threads) {
      thread.state = "submitted";
      thread.submittedAt = now;
      thread.lastDispatchId = dispatchId;
    }

    state.pendingDispatches.push({
      id: dispatchId,
      threadIds: threads.map((thread) => thread.id),
      createdAt: now,
      baseRef: snapshot?.baseRef ?? state.baseRef ?? state.defaultBranch ?? "HEAD",
    });

    persistState();
    updateStatus(ctx);

    await ctx.waitForIdle();
    pi.sendUserMessage(buildDispatchPrompt(snapshot?.baseRef ?? state.baseRef ?? "HEAD", threads));
    ctx.ui.notify(
      `Sent ${threads.length} review thread${threads.length === 1 ? "" : "s"}. Reopen /review after the agent responds.`,
      "info",
    );
    return true;
  };

  const deleteThread = (threadId: string) => {
    state.threads = state.threads.filter((thread) => thread.id !== threadId);
    state.pendingDispatches = state.pendingDispatches
      .map((dispatch) => ({ ...dispatch, threadIds: dispatch.threadIds.filter((id) => id !== threadId) }))
      .filter((dispatch) => dispatch.threadIds.length > 0);
  };

  pi.on("session_start", async (_event, ctx) => {
    loadState(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    loadState(ctx);
  });

  pi.on("agent_end", async (event, ctx) => {
    const pending = state.pendingDispatches[0];
    if (!pending) {
      updateStatus(ctx);
      return;
    }

    const assistantText = getLastAssistantText(event.messages as Array<{ role?: string; content?: unknown[] }>);
    const trimmedAssistantText = assistantText.trim();
    const parsed = parseThreadResponses(trimmedAssistantText);
    const rawBatchFallback = pending.threadIds.length > 1 && parsed.size === 0 && trimmedAssistantText.length > 0;
    const now = Date.now();

    for (const threadId of pending.threadIds) {
      const thread = state.threads.find((candidate) => candidate.id === threadId);
      if (!thread) continue;

      const response = parsed.get(threadId);
      if (response) {
        thread.state = "responded";
        thread.responseStatus = response.status;
        thread.responseText = response.responseText;
        thread.respondedAt = now;
      } else if (pending.threadIds.length === 1 && trimmedAssistantText.length > 0) {
        thread.state = "responded";
        thread.responseStatus = "answered";
        thread.responseText = trimmedAssistantText;
        thread.respondedAt = now;
      } else if (rawBatchFallback) {
        thread.state = "responded";
        thread.responseStatus = "needs-follow-up";
        thread.responseText = `Raw batch response (thread tags missing):\n\n${trimmedAssistantText}`;
        thread.respondedAt = now;
      }
    }

    state.pendingDispatches = state.pendingDispatches.filter((candidate) => candidate.id !== pending.id);
    persistState();
    updateStatus(ctx);

    if (ctx.hasUI) {
      const responded = pending.threadIds.filter((threadId) => {
        const thread = state.threads.find((candidate) => candidate.id === threadId);
        return thread?.state === "responded";
      }).length;
      if (responded > 0) {
        ctx.ui.notify(`Attached ${responded} review response${responded === 1 ? "" : "s"}.`, "info");
      } else if (trimmedAssistantText.length > 0) {
        ctx.ui.notify("Review reply arrived, but it could not be matched back to a thread.", "warning");
      }
    }
  });

  pi.registerCommand("review", {
    description: "Review the current git diff against the default branch, file by file",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/review requires the interactive TUI.", "error");
        return;
      }

      const requestedBaseRef = args.trim() || undefined;

      try {
        snapshot = await buildSnapshot(requestedBaseRef);
        state.baseRef = snapshot.baseRef;
        state.defaultBranch = snapshot.defaultBranch;
        applySelectionToSnapshot(snapshot, uiState, state.selection);
        ensureFileSelected(snapshot, uiState);
        persistState();
        updateStatus(ctx);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Unable to open review: ${message}`, "error");
        return;
      }

      while (true) {
        if (!snapshot) break;
        applySelectionToSnapshot(snapshot, uiState, state.selection);
        const action = await ctx.ui.custom<ReviewAction>((tui, theme, _kb, done) => {
          return new ReviewBrowserComponent(tui, state, uiState, snapshot!, theme, done);
        });
        persistState();

        if (!action || action.type === "close") break;

        if (action.type === "refresh") {
          try {
            snapshot = await buildSnapshot(requestedBaseRef ?? state.baseRef);
            applySelectionToSnapshot(snapshot, uiState, state.selection);
            persistState();
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            ctx.ui.notify(`Refresh failed: ${message}`, "error");
          }
          continue;
        }

        if (action.type === "saved-thread") {
          ctx.ui.notify("Saved review comment.", "info");
          continue;
        }

        if (action.type === "dispatch-threads") {
          const threads = action.threadIds
            .map((threadId) => state.threads.find((thread) => thread.id === threadId))
            .filter((thread): thread is ReviewThread => !!thread);
          if (threads.length === 0) continue;

          const dispatched = await dispatchThreads(threads, ctx);
          if (dispatched) break;
          continue;
        }

        if (action.type === "delete-thread") {
          const visibleThreads = action.visibleThreadIds
            .map((threadId) => state.threads.find((thread) => thread.id === threadId))
            .filter((thread): thread is ReviewThread => !!thread);
          if (visibleThreads.length === 0) {
            ctx.ui.notify("There are no visible review comments to delete here.", "warning");
            continue;
          }

          let targetThread = visibleThreads[0]!;
          if (visibleThreads.length > 1) {
            const options = visibleThreads.map(
              (thread, index) => `[${index + 1}] ${threadLocationLabel(thread)} • ${thread.comment.split("\n")[0]!.trim() || "(empty)"}`,
            );
            const choice = await ctx.ui.select("Delete which review comment?", options);
            if (!choice) continue;
            const selectedIndex = options.indexOf(choice);
            if (selectedIndex < 0) continue;
            targetThread = visibleThreads[selectedIndex]!;
          }

          const confirmed = await ctx.ui.confirm(
            "Delete review comment?",
            `Delete this review comment on ${targetThread.displayPath} (${threadLocationLabel(targetThread)})?`,
          );
          if (!confirmed) continue;

          deleteThread(targetThread.id);
          persistState();
          updateStatus(ctx);
          ctx.ui.notify("Deleted review comment.", "info");
          continue;
        }

        if (action.type === "send-batch") {
          const queuedThreads = state.threads.filter((thread) => thread.state === "queued");
          if (queuedThreads.length === 0) {
            ctx.ui.notify("There are no queued review threads to send.", "warning");
            continue;
          }

          const confirmed = await ctx.ui.confirm(
            "Send queued review threads?",
            `Send ${queuedThreads.length} queued review thread${queuedThreads.length === 1 ? "" : "s"} to the agent now?`,
          );
          if (!confirmed) continue;

          const dispatched = await dispatchThreads(queuedThreads, ctx);
          if (dispatched) break;
        }
      }

      snapshot = undefined;
      updateStatus(ctx);
    },
  });
}
