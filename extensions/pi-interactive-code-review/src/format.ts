import type { Theme } from "@mariozechner/pi-coding-agent";
import { type EditorTheme, wrapTextWithAnsi, truncateToWidth } from "@mariozechner/pi-tui";
import type { DiffFile, DiffHunk, DiffLine, PersistedReviewState, ReviewThread, ThreadCommentKind } from "./types.js";
import { lineMatchesAnchor } from "./state.js";

const LINE_CONTEXT_RADIUS = 3;
const MAX_HUNK_EXCERPT_LINES = 24;

export function formatCount(label: string, count: number): string {
  return `${count} ${label}${count === 1 ? "" : "s"}`;
}

export function formatQueuedThreadCount(count: number): string {
  return formatCount("queued thread", count);
}

export function formatAwaitingReplyCount(count: number): string {
  return `${count} awaiting ${count === 1 ? "reply" : "replies"}`;
}

export function lineLabel(line: DiffLine): string {
  if (line.newLineNumber !== undefined) return `L${line.newLineNumber}`;
  if (line.oldLineNumber !== undefined) return `old L${line.oldLineNumber}`;
  return "line";
}

export function threadStatusText(thread: ReviewThread): string {
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

export function threadStatusColor(thread: ReviewThread): "accent" | "warning" | "success" | "muted" {
  if (thread.state === "queued") return "accent";
  if (thread.state === "submitted") return "warning";
  if (thread.responseStatus === "needs-follow-up") return "warning";
  if (thread.responseStatus === "changed") return "success";
  return "muted";
}

export function threadLocationLabel(thread: ReviewThread): string {
  if (thread.target.kind === "file") return "file";
  if (thread.target.kind === "hunk") return thread.target.hunkHeader ?? "hunk";
  if (thread.target.newLineNumber !== undefined) return `L${thread.target.newLineNumber}`;
  if (thread.target.oldLineNumber !== undefined) return `old L${thread.target.oldLineNumber}`;
  return "line";
}

export function countQueuedThreads(state: PersistedReviewState): number {
  return state.threads.filter((thread) => thread.state === "queued").length;
}

export function countAwaitingThreads(state: PersistedReviewState): number {
  return state.threads.filter((thread) => thread.state === "submitted").length;
}

export function matchingThreadScore(
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

export function getThreadsForCurrentView(
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

export function countThreadsForLine(state: PersistedReviewState, file: DiffFile, hunk: DiffHunk, line: DiffLine): number {
  return state.threads.filter((thread) => matchingThreadScore(thread, file, hunk, line) === 3).length;
}

export function countThreadsForHunk(state: PersistedReviewState, file: DiffFile, hunk: DiffHunk): number {
  return state.threads.filter((thread) => matchingThreadScore(thread, file, hunk, undefined) >= 2).length;
}

export function countThreadsForFile(state: PersistedReviewState, file: DiffFile): number {
  return state.threads.filter((thread) => matchingThreadScore(thread, file, undefined, undefined) >= 1).length;
}

export function renderWrapped(text: string, width: number, lines: string[], indent = "") {
  const wrapped = wrapTextWithAnsi(text, Math.max(10, width - indent.length));
  for (const line of wrapped) {
    lines.push(truncateToWidth(`${indent}${line}`, width));
  }
}

export function inferCommentKind(text: string): ThreadCommentKind {
  const trimmed = text.trim();
  return trimmed.endsWith("?") || /\?\s*$/m.test(trimmed) ? "question" : "comment";
}

export function buildLineExcerpt(hunk: DiffHunk, lineIndex: number): string {
  const start = Math.max(0, lineIndex - LINE_CONTEXT_RADIUS);
  const end = Math.min(hunk.lines.length, lineIndex + LINE_CONTEXT_RADIUS + 1);
  return hunk.lines
    .slice(start, end)
    .map((line) => `${line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}${line.text}`)
    .join("\n");
}

export function buildHunkExcerpt(hunk: DiffHunk): string {
  const lines = hunk.lines.slice(0, MAX_HUNK_EXCERPT_LINES).map((line) => {
    const prefix = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
    return `${prefix}${line.text}`;
  });
  if (hunk.lines.length > MAX_HUNK_EXCERPT_LINES) lines.push("... (hunk truncated)");
  return [hunk.header, ...lines].join("\n");
}

export function buildFileExcerpt(file: DiffFile): string {
  if (file.hunks.length === 0) return file.note ?? `${file.displayPath} changed.`;
  const selectedHunks = file.hunks.slice(0, 2).map((hunk) => buildHunkExcerpt(hunk));
  return selectedHunks.join("\n\n");
}

export function createEditorTheme(theme: Theme): EditorTheme {
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

export function formatFileChangeSummary(file: DiffFile): string {
  return `+${file.additions} -${file.deletions} • ${file.status}`;
}

export function formatFileJumpDescription(file: DiffFile, state: PersistedReviewState): string {
  const parts = [formatFileChangeSummary(file)];
  if (file.hunks.length > 0) parts.push(formatCount("hunk", file.hunks.length));
  else if (file.note) parts.push("no text hunks");

  const threadCount = countThreadsForFile(state, file);
  if (threadCount > 0) parts.push(formatCount("thread", threadCount));
  return parts.join(" • ");
}

export function highlightMatchedCharacters(text: string, positions: number[], theme: Theme): string {
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
