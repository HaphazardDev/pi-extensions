import fs from "node:fs";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Editor, Key, matchesKey, SelectList, type SelectItem, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { buildFileExcerpt, buildHunkExcerpt, buildLineExcerpt, countAwaitingThreads, countQueuedThreads, countThreadsForFile, countThreadsForHunk, countThreadsForLine, createEditorTheme, formatAwaitingReplyCount, formatCount, formatFileChangeSummary, formatFileJumpDescription, formatQueuedThreadCount, getThreadsForCurrentView, highlightMatchedCharacters, inferCommentKind, lineLabel, renderWrapped, threadLocationLabel, threadStatusColor, threadStatusText } from "./format.js";
import { parseGitDiff } from "./diff.js";
import { findDiffSearchMatches, scoreFileJumpMatch } from "./search.js";
import { applySelectionToSnapshot, captureSelection, clampSelectionToSnapshot, createEmptyState, createUIState, currentFile, currentHunk, currentLine, lineMatchesAnchor } from "./state.js";
import { buildDispatchPrompt, parseThreadResponses } from "./threads.js";
import type { DiffFile, DiffHunk, DiffLine, DiffSearchMatch, FileJumpItem, FileJumpMatch, PersistedReviewState, ReviewAction, ReviewSnapshot, ReviewTarget, ReviewThread, ReviewUIState, ThreadCommentKind, ThreadTargetKind } from "./types.js";

const REVIEW_STATE_TYPE = "interactive-code-review-state";
const STATUS_KEY = "interactive-code-review";
const DEFAULT_VISIBLE_DIFF_LINES = 18;
const DEFAULT_TERMINAL_ROWS = 24;
const RESERVED_TOP_CONTEXT_ROWS = 4;
const VIEWPORT_SAFETY_ROWS = 3;

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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function basenameFromPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;
}

interface ParsedReviewArgs {
  repoPath?: string;
  baseRef?: string;
  scanDepth?: number;
  pick?: boolean;
  includeClean?: boolean;
  current?: boolean;
}

export interface RepoDiscoveryOptions {
  maxDepth: number;
  maxRepos: number;
}

export interface DiscoveredRepo {
  repoPath: string;
  displayPath: string;
  kind: "current" | "child" | "parent";
  branch?: string;
  defaultBranch?: string;
  changedFiles: number;
  additions: number;
  deletions: number;
  dirty: boolean;
  error?: string;
}

export const DEFAULT_REPO_SCAN_DEPTH = 3;
export const DEFAULT_REPO_SCAN_LIMIT = 50;
export const SKIP_DISCOVERY_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", "coverage", "vendor"]);

function shellSplitArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaping = false;

  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaping) current += "\\";
  if (quote) throw new Error("Unclosed quote in /review arguments.");
  if (current.length > 0) args.push(current);
  return args;
}

function looksLikeGitRepoDirectory(candidatePath: string): boolean {
  try {
    const stat = fs.statSync(candidatePath);
    if (!stat.isDirectory()) return false;
    return fs.existsSync(path.join(candidatePath, ".git"));
  } catch {
    return false;
  }
}

export function getReviewTargetKey(repoPath: string): string {
  return path.resolve(repoPath);
}

function formatRepoDisplayPath(repoPath: string): string {
  const relative = path.relative(process.cwd(), repoPath) || ".";
  return relative.split(path.sep).join("/");
}

export function parseReviewArgs(input: string): ParsedReviewArgs {
  const tokens = shellSplitArgs(input.trim());
  const parsed: ParsedReviewArgs = {};
  const positional: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === "--repo") {
      const value = tokens[++i];
      if (!value) throw new Error("Missing value for --repo.");
      parsed.repoPath = value;
      continue;
    }
    if (token.startsWith("--repo=")) {
      parsed.repoPath = token.slice("--repo=".length);
      continue;
    }
    if (token === "--base") {
      const value = tokens[++i];
      if (!value) throw new Error("Missing value for --base.");
      parsed.baseRef = value;
      continue;
    }
    if (token.startsWith("--base=")) {
      parsed.baseRef = token.slice("--base=".length);
      continue;
    }
    if (token === "--scan-depth") {
      const value = tokens[++i];
      if (!value) throw new Error("Missing value for --scan-depth.");
      parsed.scanDepth = Number(value);
      if (!Number.isInteger(parsed.scanDepth) || parsed.scanDepth < 0) throw new Error("--scan-depth must be a non-negative integer.");
      continue;
    }
    if (token.startsWith("--scan-depth=")) {
      parsed.scanDepth = Number(token.slice("--scan-depth=".length));
      if (!Number.isInteger(parsed.scanDepth) || parsed.scanDepth < 0) throw new Error("--scan-depth must be a non-negative integer.");
      continue;
    }
    if (token === "--pick") {
      parsed.pick = true;
      continue;
    }
    if (token === "--include-clean") {
      parsed.includeClean = true;
      continue;
    }
    if (token === "--current") {
      parsed.current = true;
      continue;
    }
    if (token.startsWith("--")) throw new Error(`Unknown option ${token}.`);
    positional.push(token);
  }

  if (positional.length > 1) throw new Error("Too many positional arguments. Use --repo <path> and --base <ref> for clarity.");
  if (positional.length === 1) {
    const value = positional[0]!;
    const absolute = path.resolve(process.cwd(), value);
    if (!parsed.repoPath && looksLikeGitRepoDirectory(absolute)) parsed.repoPath = value;
    else if (!parsed.baseRef) parsed.baseRef = value;
    else throw new Error(`Unexpected positional argument ${value}.`);
  }

  return parsed;
}

export function hasGitMarker(directory: string): boolean {
  return fs.existsSync(path.join(directory, ".git"));
}

function hasGitFileMarker(directory: string): boolean {
  try {
    return fs.statSync(path.join(directory, ".git")).isFile();
  } catch {
    return false;
  }
}

export function findAncestorGitRepoMarkers(start: string): string[] {
  const repos: string[] = [];
  let current = path.resolve(start);
  while (true) {
    if (hasGitMarker(current)) repos.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return repos;
}

export function rankDiscoveredRepos(repos: DiscoveredRepo[], recentTargets: Array<{ repoPath: string; reviewedAt: number }> = []): DiscoveredRepo[] {
  const kindRank = (repo: DiscoveredRepo) => repo.kind === "parent" ? 0 : repo.kind === "current" ? 1 : 2;
  return [...repos].sort((a, b) => {
    if (a.dirty !== b.dirty) return a.dirty ? -1 : 1;
    const aNonDefault = !!a.branch && !!a.defaultBranch && a.branch !== basenameFromPath(a.defaultBranch);
    const bNonDefault = !!b.branch && !!b.defaultBranch && b.branch !== basenameFromPath(b.defaultBranch);
    if (aNonDefault !== bNonDefault) return aNonDefault ? -1 : 1;
    const aRecent = recentTargets.find((target) => target.repoPath === a.repoPath)?.reviewedAt ?? 0;
    const bRecent = recentTargets.find((target) => target.repoPath === b.repoPath)?.reviewedAt ?? 0;
    if (aRecent !== bRecent) return bRecent - aRecent;
    return kindRank(a) - kindRank(b) || a.displayPath.localeCompare(b.displayPath);
  });
}

export function walkChildRepoCandidates(root: string, options: RepoDiscoveryOptions): string[] {
  const repos: string[] = [];

  const visit = (directory: string, depth: number) => {
    if (repos.length >= options.maxRepos || depth > options.maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (repos.length >= options.maxRepos) return;
      if (!entry.isDirectory()) continue;
      if (SKIP_DISCOVERY_DIRS.has(entry.name)) continue;

      const childPath = path.join(directory, entry.name);
      if (hasGitMarker(childPath)) {
        repos.push(childPath);
        continue;
      }
      visit(childPath, depth + 1);
    }
  };

  visit(root, 1);
  return repos;
}

function formatReviewStatus(theme: ExtensionContext["ui"]["theme"], state: PersistedReviewState): string | undefined {
  const queued = countQueuedThreads(state);
  const awaiting = countAwaitingThreads(state);
  if (queued === 0 && awaiting === 0) return undefined;

  const reviewLabel = state.repoDisplayPath && state.repoDisplayPath !== "." ? `review ${state.repoDisplayPath}` : "review";
  const segments: string[] = [theme.fg("accent", reviewLabel)];
  if (queued > 0) segments.push(theme.fg("accent", formatQueuedThreadCount(queued)));
  if (awaiting > 0) segments.push(theme.fg("warning", formatAwaitingReplyCount(awaiting)));
  return `🧵 ${segments.join(" • ")}`;
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
      repoPath: this.snapshot.repoPath,
      repoDisplayPath: this.snapshot.repoDisplayPath,
      baseRef: this.snapshot.baseRef,
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
      theme.fg("accent", theme.bold(`Review ${this.snapshot.repoDisplayPath}`)),
      theme.fg("muted", `against ${this.snapshot.baseRef}`),
      theme.fg("muted", `${this.snapshot.files.length} ${this.snapshot.files.length === 1 ? "file" : "files"}`),
      theme.fg(this.uiState.wrapDiff ? "accent" : "dim", `wrap ${this.uiState.wrapDiff ? "on" : "off"}`),
    ];
    if (queued > 0) headerParts.push(theme.fg("accent", formatQueuedThreadCount(queued)));
    if (awaiting > 0) headerParts.push(theme.fg("warning", formatAwaitingReplyCount(awaiting)));
    lines.push(truncateToWidth(headerParts.join(theme.fg("dim", " • ")), width));

    const additions = this.snapshot.files.reduce((total, candidate) => total + candidate.additions, 0);
    const deletions = this.snapshot.files.reduce((total, candidate) => total + candidate.deletions, 0);
    lines.push(truncateToWidth(theme.fg("dim", `${this.snapshot.files.length} ${this.snapshot.files.length === 1 ? "file" : "files"} • +${additions} -${deletions}`), width));

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
  let discoveryCache: { key: string; repos: DiscoveredRepo[] } | undefined;

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

  const execGit = async (target: ReviewTarget, args: string[]) => {
    const result = await pi.exec("git", ["-C", target.repoPath, ...args]);
    return result;
  };

  const tryGit = async (target: ReviewTarget, args: string[]): Promise<string | undefined> => {
    const result = await execGit(target, args);
    if (result.code !== 0) return undefined;
    const text = result.stdout.trim();
    return text.length > 0 ? text : undefined;
  };

  const resolveDefaultBranch = async (target: ReviewTarget): Promise<string> => {
    const remoteHead = await tryGit(target, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
    if (remoteHead) return remoteHead;

    const remoteMain = await tryGit(target, ["rev-parse", "--verify", "refs/remotes/origin/main"]);
    if (remoteMain) return "origin/main";

    const remoteMaster = await tryGit(target, ["rev-parse", "--verify", "refs/remotes/origin/master"]);
    if (remoteMaster) return "origin/master";

    const localMain = await tryGit(target, ["rev-parse", "--verify", "main"]);
    if (localMain) return "main";

    const localMaster = await tryGit(target, ["rev-parse", "--verify", "master"]);
    if (localMaster) return "master";

    throw new Error("Could not determine a default branch. Try /review <base-ref>.");
  };

  const getUntrackedPaths = async (target: ReviewTarget): Promise<string[]> => {
    const result = await execGit(target, ["ls-files", "--others", "--exclude-standard", "-z"]);
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || "Failed to list untracked files.");
    }

    return result.stdout
      .split("\0")
      .map((path) => path.trim())
      .filter((path) => path.length > 0);
  };

  const buildUntrackedDiff = async (target: ReviewTarget, path: string): Promise<string> => {
    const result = await execGit(target, ["diff", "--no-index", "--unified=3", "--no-color", "/dev/null", path]);
    if (result.code !== 0 && result.code !== 1) {
      throw new Error(result.stderr.trim() || `Failed to diff untracked file ${path}.`);
    }
    return result.stdout;
  };

  const summarizeDiscoveredRepo = async (repoPath: string, kind: DiscoveredRepo["kind"]): Promise<DiscoveredRepo> => {
    const target: ReviewTarget = { repoPath, displayPath: formatRepoDisplayPath(repoPath) };
    const base: DiscoveredRepo = {
      repoPath,
      displayPath: target.displayPath,
      kind,
      changedFiles: 0,
      additions: 0,
      deletions: 0,
      dirty: false,
    };

    try {
      base.branch = await tryGit(target, ["branch", "--show-current"]);
      base.defaultBranch = await resolveDefaultBranch(target).catch(() => undefined);

      const status = await execGit(target, ["status", "--porcelain"]);
      if (status.code !== 0) throw new Error(status.stderr.trim() || "git status failed");
      base.dirty = status.stdout.trim().length > 0;
      base.changedFiles = status.stdout.split("\n").filter((line) => line.trim().length > 0).length;

      const shortstat = await execGit(target, ["diff", "--shortstat", "HEAD"]);
      if (shortstat.code === 0) {
        const text = shortstat.stdout.trim();
        base.additions = Number(/(\d+) insertion/.exec(text)?.[1] ?? 0);
        base.deletions = Number(/(\d+) deletion/.exec(text)?.[1] ?? 0);
      }
    } catch (error) {
      base.error = error instanceof Error ? error.message : String(error);
    }

    return base;
  };


  const formatRecentHint = (repoPath: string): string | undefined => {
    const reviewedAt = state.recentTargets?.find((target) => target.repoPath === repoPath)?.reviewedAt;
    if (!reviewedAt) return undefined;
    const elapsedSeconds = Math.max(1, Math.floor((Date.now() - reviewedAt) / 1000));
    if (elapsedSeconds < 60) return `last reviewed ${elapsedSeconds}s ago`;
    const elapsedMinutes = Math.floor(elapsedSeconds / 60);
    if (elapsedMinutes < 60) return `last reviewed ${elapsedMinutes}m ago`;
    const elapsedHours = Math.floor(elapsedMinutes / 60);
    return `last reviewed ${elapsedHours}h ago`;
  };

  const formatRepoPickerOptions = (repos: DiscoveredRepo[]): string[] => {
    const labels = repos.map((repo) => ({
      repo,
      path: repo.displayPath,
      kind: `${repo.kind} repo`,
      branch: repo.branch || "detached",
      summary: repo.error
        ? `! ${repo.error}`
        : repo.dirty
          ? `● ${repo.changedFiles} ${repo.changedFiles === 1 ? "file" : "files"}  +${repo.additions} -${repo.deletions}`
          : "○ clean",
      recentHint: formatRecentHint(repo.repoPath),
    }));
    const pathWidth = Math.min(40, Math.max(1, ...labels.map((label) => label.path.length)));
    const kindWidth = Math.max(1, ...labels.map((label) => label.kind.length));
    const branchWidth = Math.min(24, Math.max(1, ...labels.map((label) => label.branch.length)));

    return labels.map((label) => {
      const displayPath = label.path.length > pathWidth ? `…${label.path.slice(-pathWidth + 1)}` : label.path;
      const branch = label.branch.length > branchWidth ? `…${label.branch.slice(-branchWidth + 1)}` : label.branch;
      const columns = [
        displayPath.padEnd(pathWidth),
        label.kind.padEnd(kindWidth),
        branch.padEnd(branchWidth),
        label.summary,
      ];
      if (label.recentHint) columns.push(label.recentHint);
      return columns.join("  ");
    });
  };

  const discoverReviewRepos = async (options: Partial<RepoDiscoveryOptions> = {}): Promise<DiscoveredRepo[]> => {
    const discoveryOptions: RepoDiscoveryOptions = {
      maxDepth: options.maxDepth ?? DEFAULT_REPO_SCAN_DEPTH,
      maxRepos: options.maxRepos ?? DEFAULT_REPO_SCAN_LIMIT,
    };
    const cwd = process.cwd();
    const cacheKey = `${cwd}:${discoveryOptions.maxDepth}:${discoveryOptions.maxRepos}`;
    if (discoveryCache?.key === cacheKey) return discoveryCache.repos;

    const repos = new Map<string, DiscoveredRepo["kind"]>();

    const currentTarget = await resolveReviewTarget(".").catch(() => undefined);
    if (currentTarget) repos.set(currentTarget.repoPath, "current");

    const currentIsLinkedWorktree = currentTarget ? hasGitFileMarker(currentTarget.repoPath) : false;
    if (!currentIsLinkedWorktree) {
      for (const ancestor of findAncestorGitRepoMarkers(path.dirname(cwd))) {
        const target = await resolveReviewTarget(ancestor).catch(() => undefined);
        if (target && !repos.has(target.repoPath)) repos.set(target.repoPath, "parent");
      }
    }

    const outerRoot = currentIsLinkedWorktree ? { code: 1, stdout: "" } : await pi.exec("git", ["rev-parse", "--show-superproject-working-tree"]);
    if (outerRoot.code === 0 && outerRoot.stdout.trim()) {
      const parentPath = path.resolve(outerRoot.stdout.trim());
      const target = await resolveReviewTarget(parentPath).catch(() => undefined);
      if (target && !repos.has(target.repoPath)) repos.set(target.repoPath, "parent");
    }

    for (const candidate of walkChildRepoCandidates(cwd, discoveryOptions)) {
      const target = await resolveReviewTarget(candidate).catch(() => undefined);
      if (!target) continue;
      if (!repos.has(target.repoPath)) repos.set(target.repoPath, "child");
      if (repos.size >= discoveryOptions.maxRepos) break;
    }

    const summaries: DiscoveredRepo[] = [];
    for (const [repoPath, kind] of repos) {
      summaries.push(await summarizeDiscoveredRepo(repoPath, kind));
    }
    discoveryCache = { key: cacheKey, repos: summaries };
    return summaries;
  };

  const resolveReviewTarget = async (repoPath?: string): Promise<ReviewTarget> => {
    const requestedPath = path.resolve(process.cwd(), repoPath || state.repoPath || ".");
    if (!fs.existsSync(requestedPath)) throw new Error(`Review target does not exist: ${repoPath || requestedPath}`);
    if (!fs.statSync(requestedPath).isDirectory()) throw new Error(`Review target is not a directory: ${repoPath || requestedPath}`);

    const provisional: ReviewTarget = {
      repoPath: requestedPath,
      displayPath: formatRepoDisplayPath(requestedPath),
    };
    const root = await execGit(provisional, ["rev-parse", "--show-toplevel"]);
    if (root.code !== 0) {
      throw new Error(root.stderr.trim() || `Review target is not a git repository: ${provisional.displayPath}`);
    }

    const repoRoot = path.resolve(root.stdout.trim());
    return {
      repoPath: repoRoot,
      displayPath: formatRepoDisplayPath(repoRoot),
    };
  };

  const rememberReviewTarget = (targetSnapshot: ReviewSnapshot) => {
    const existing = state.recentTargets?.filter((target) => target.repoPath !== targetSnapshot.repoPath) ?? [];
    state.recentTargets = [
      { repoPath: targetSnapshot.repoPath, repoDisplayPath: targetSnapshot.repoDisplayPath, reviewedAt: Date.now() },
      ...existing,
    ].slice(0, 10);
  };

  const chooseReviewTarget = async (parsedArgs: ParsedReviewArgs, ctx: ExtensionCommandContext): Promise<ReviewTarget> => {
    if (parsedArgs.repoPath) return resolveReviewTarget(parsedArgs.repoPath);
    if (parsedArgs.current) return resolveReviewTarget(".");
    if (parsedArgs.baseRef) return resolveReviewTarget(".");

    const discovered = rankDiscoveredRepos(await discoverReviewRepos({ maxDepth: parsedArgs.scanDepth }), state.recentTargets);
    const visibleRepos = parsedArgs.includeClean ? discovered : discovered.filter((repo) => repo.dirty || repo.error);
    const dirtyRepos = discovered.filter((repo) => repo.dirty && !repo.error);

    if ((parsedArgs.pick || parsedArgs.includeClean) && visibleRepos.length > 0) {
      const options = formatRepoPickerOptions(visibleRepos);
      const choice = await ctx.ui.select("Select review target", options);
      if (!choice) throw new Error("Review target selection cancelled.");
      const selected = visibleRepos[options.indexOf(choice)];
      if (!selected) throw new Error("Review target selection failed.");
      return { repoPath: selected.repoPath, displayPath: selected.displayPath };
    }

    if (!parsedArgs.baseRef && dirtyRepos.length === 1) {
      const selected = dirtyRepos[0]!;
      return { repoPath: selected.repoPath, displayPath: selected.displayPath };
    }

    if (!parsedArgs.baseRef && dirtyRepos.length > 1) {
      const options = formatRepoPickerOptions(dirtyRepos);
      const choice = await ctx.ui.select("Select review target", options);
      if (!choice) throw new Error("Review target selection cancelled.");
      const selected = dirtyRepos[options.indexOf(choice)];
      if (!selected) throw new Error("Review target selection failed.");
      return { repoPath: selected.repoPath, displayPath: selected.displayPath };
    }

    const defaultRepo = discovered.find((repo) => repo.kind === "parent") ?? discovered.find((repo) => repo.kind === "current");
    if (defaultRepo) return { repoPath: defaultRepo.repoPath, displayPath: defaultRepo.displayPath };
    return resolveReviewTarget(".");
  };

  const buildSnapshot = async (target: ReviewTarget, requestedBaseRef?: string): Promise<ReviewSnapshot> => {
    const sameRepoAsState = state.repoPath === target.repoPath;
    const defaultBranch = sameRepoAsState && state.defaultBranch
      ? state.defaultBranch
      : (requestedBaseRef?.trim() ? undefined : await resolveDefaultBranch(target));
    const baseRef = requestedBaseRef?.trim() || (sameRepoAsState ? state.baseRef : undefined) || defaultBranch;
    if (!baseRef) {
      throw new Error("Could not determine a review base. Try /review --base <base-ref>.");
    }
    const verify = await execGit(target, ["rev-parse", "--verify", baseRef]);
    if (verify.code !== 0) {
      const reason = verify.stderr.trim() || `Unable to resolve ${baseRef}`;
      throw new Error(`Unable to resolve base ref ${baseRef} in ${target.displayPath}: ${reason}`);
    }

    const mergeBase = await execGit(target, ["merge-base", baseRef, "HEAD"]);
    if (mergeBase.code !== 0) {
      throw new Error(mergeBase.stderr.trim() || `Unable to compute merge-base for ${baseRef} and HEAD in ${target.displayPath}`);
    }

    const mergeBaseSha = mergeBase.stdout.trim();
    const trackedDiff = await execGit(target, ["diff", "--unified=3", "--no-color", "--find-renames", mergeBaseSha]);
    if (trackedDiff.code !== 0) {
      throw new Error(trackedDiff.stderr.trim() || `git diff failed for ${mergeBaseSha} in ${target.displayPath}`);
    }

    const untrackedPaths = await getUntrackedPaths(target);
    const untrackedDiffs: string[] = [];
    for (const path of untrackedPaths) {
      untrackedDiffs.push(await buildUntrackedDiff(target, path));
    }

    const combinedDiff = [trackedDiff.stdout, ...untrackedDiffs].filter((chunk) => chunk.trim().length > 0).join("\n");
    const files = parseGitDiff(combinedDiff);
    return {
      repoPath: target.repoPath,
      repoDisplayPath: target.displayPath,
      baseRef,
      defaultBranch: defaultBranch ?? baseRef,
      files,
    };
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
      repoPath: snapshot?.repoPath ?? state.repoPath,
      repoDisplayPath: snapshot?.repoDisplayPath ?? state.repoDisplayPath,
      threadIds: threads.map((thread) => thread.id),
      createdAt: now,
      baseRef: snapshot?.baseRef ?? state.baseRef ?? state.defaultBranch ?? "HEAD",
    });

    persistState();
    updateStatus(ctx);

    await ctx.waitForIdle();
    pi.sendUserMessage(buildDispatchPrompt(snapshot?.baseRef ?? state.baseRef ?? "HEAD", threads));
    const repoLabel = snapshot?.repoDisplayPath ?? state.repoDisplayPath ?? ".";
    ctx.ui.notify(
      `Sent ${threads.length} review thread${threads.length === 1 ? "" : "s"} for ${repoLabel}. Reopen /review after the agent responds.`,
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
      const thread = state.threads.find((candidate) => candidate.id === threadId && (!pending.repoPath || !candidate.repoPath || candidate.repoPath === pending.repoPath));
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
        const thread = state.threads.find((candidate) => candidate.id === threadId && (!pending.repoPath || !candidate.repoPath || candidate.repoPath === pending.repoPath));
        return thread?.state === "responded";
      }).length;
      if (responded > 0) {
        const repoLabel = state.repoDisplayPath ?? ".";
        ctx.ui.notify(`Attached ${responded} review response${responded === 1 ? "" : "s"} for ${repoLabel}.`, "info");
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

      let requestedBaseRef: string | undefined;
      let target: ReviewTarget;

      try {
        const parsedArgs = parseReviewArgs(args);
        requestedBaseRef = parsedArgs.baseRef;
        target = await chooseReviewTarget(parsedArgs, ctx);
        const previousRepoPath = state.repoPath;
        snapshot = await buildSnapshot(target, requestedBaseRef);
        if (previousRepoPath && previousRepoPath !== snapshot.repoPath) state.selection = {};
        for (const thread of state.threads) {
          if (!thread.repoPath) {
            thread.repoPath = snapshot.repoPath;
            thread.repoDisplayPath = snapshot.repoDisplayPath;
          }
        }
        for (const dispatch of state.pendingDispatches) {
          if (!dispatch.repoPath) {
            dispatch.repoPath = snapshot.repoPath;
            dispatch.repoDisplayPath = snapshot.repoDisplayPath;
          }
        }
        state.repoPath = snapshot.repoPath;
        state.repoDisplayPath = snapshot.repoDisplayPath;
        state.baseRef = snapshot.baseRef;
        rememberReviewTarget(snapshot);
        state.defaultBranch = snapshot.defaultBranch;
        applySelectionToSnapshot(snapshot, uiState, state.selection);
        ensureFileSelected(snapshot, uiState);
        persistState();
        updateStatus(ctx);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Unable to open review${state.repoDisplayPath ? ` for ${state.repoDisplayPath}` : ""}: ${message}`, "error");
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
            const refreshTarget = await resolveReviewTarget(state.repoPath);
            snapshot = await buildSnapshot(refreshTarget, requestedBaseRef ?? state.baseRef);
            applySelectionToSnapshot(snapshot, uiState, state.selection);
            persistState();
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            ctx.ui.notify(`Refresh failed for ${state.repoDisplayPath ?? "."}: ${message}`, "error");
          }
          continue;
        }

        if (action.type === "saved-thread") {
          ctx.ui.notify("Saved review comment.", "info");
          continue;
        }

        if (action.type === "dispatch-threads") {
          const threads = action.threadIds
            .map((threadId) => state.threads.find((thread) => thread.id === threadId && (!state.repoPath || !thread.repoPath || thread.repoPath === state.repoPath)))
            .filter((thread): thread is ReviewThread => !!thread);
          if (threads.length === 0) continue;

          const dispatched = await dispatchThreads(threads, ctx);
          if (dispatched) break;
          continue;
        }

        if (action.type === "delete-thread") {
          const visibleThreads = action.visibleThreadIds
            .map((threadId) => state.threads.find((thread) => thread.id === threadId && (!state.repoPath || !thread.repoPath || thread.repoPath === state.repoPath)))
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
          const queuedThreads = state.threads.filter((thread) => thread.state === "queued" && (!state.repoPath || !thread.repoPath || thread.repoPath === state.repoPath));
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
