import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import { formatDuration, formatJobStatus, truncateCommand } from "./format.js";
import type { JobInfo, LogPage } from "./types.js";

const POLL_INTERVAL_MS = 750;

export interface BackgroundJobsDataSource {
  list(): JobInfo[];
  get(id: string): JobInfo | undefined;
  readLogs(id: string, options?: { offset?: number; limit?: number }): Promise<LogPage>;
  stop(id: string): Promise<unknown>;
  remove(id: string): Promise<boolean>;
  clearCompleted(): Promise<number>;
  subscribe(listener: () => void): () => void;
}

export class BackgroundJobsBrowser {
  private selectedIndex = 0;
  private selectedListJobId: string | undefined;
  private selectedJobId: string | undefined;
  private outputOffset: number | undefined;
  private logPage: LogPage | undefined;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;
  private readonly unsubscribe: () => void;
  private readonly pollTimer: NodeJS.Timeout;
  private reloadGeneration = 0;
  private errorMessage: string | undefined;
  private logReadError: string | undefined;
  private confirmationMessage: string | undefined;
  private pendingConfirmation: string | undefined;
  private filterQuery = "";
  private filterDraft = "";
  private filterEditing = false;
  private disposed = false;

  constructor(
    private readonly tui: Pick<TUI, "requestRender" | "terminal">,
    private readonly theme: Theme,
    private readonly source: BackgroundJobsDataSource,
    private readonly done: (result: "close") => void,
  ) {
    this.unsubscribe = this.source.subscribe(() => {
      void this.reloadLogs();
      this.refresh();
    });
    this.pollTimer = setInterval(() => {
      if (this.selectedJobId) void this.reloadLogs();
    }, POLL_INTERVAL_MS);
    this.pollTimer.unref();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.reloadGeneration += 1;
    clearInterval(this.pollTimer);
    this.unsubscribe();
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  private refresh(): void {
    if (this.disposed) return;
    this.invalidate();
    this.tui.requestRender();
  }

  private async reloadLogs(): Promise<void> {
    const id = this.selectedJobId;
    if (!id) return;
    const generation = ++this.reloadGeneration;
    try {
      const summary = await this.source.readLogs(id, { offset: 0, limit: 1 });
      if (this.disposed || this.selectedJobId !== id || generation !== this.reloadGeneration) return;
      const outputRows = this.outputRows();
      const maxOffset = Math.max(0, summary.totalLines - outputRows);
      const offset = Math.max(0, Math.min(maxOffset, this.outputOffset ?? maxOffset));
      const page = await this.source.readLogs(id, { offset, limit: outputRows });
      if (this.disposed || this.selectedJobId !== id || generation !== this.reloadGeneration) return;
      this.logPage = page;
      this.logReadError = undefined;
      this.refresh();
    } catch (error) {
      if (this.disposed || this.selectedJobId !== id || generation !== this.reloadGeneration) return;
      if (this.source.get(id)) {
        this.logReadError = `Failed to read output: ${error instanceof Error ? error.message : String(error)}`;
        this.refresh();
      }
    }
  }

  private jobs(): JobInfo[] {
    const query = (this.filterEditing ? this.filterDraft : this.filterQuery).trim().toLocaleLowerCase();
    return [...this.source.list()].filter((job) => {
      if (!query) return true;
      return [job.id, job.label ?? "", job.command, job.status, formatJobStatus(job)]
        .some((value) => value.toLocaleLowerCase().includes(query));
    }).sort((left, right) => {
      const runningDifference = Number(right.status === "running") - Number(left.status === "running");
      if (runningDifference !== 0) return runningDifference;
      return Date.parse(right.startedAt) - Date.parse(left.startedAt);
    });
  }

  private selectedJob(): JobInfo | undefined {
    const jobs = this.jobs();
    if (jobs.length === 0) return undefined;
    if (this.selectedListJobId) {
      const anchoredIndex = jobs.findIndex((job) => job.id === this.selectedListJobId);
      if (anchoredIndex >= 0) this.selectedIndex = anchoredIndex;
    }
    this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, jobs.length - 1));
    const selected = jobs[this.selectedIndex];
    this.selectedListJobId = selected?.id;
    return selected;
  }

  private move(delta: number): void {
    if (this.selectedJobId) {
      const maxOffset = Math.max(0, (this.logPage?.totalLines ?? 0) - this.outputRows());
      if (this.outputOffset !== undefined || delta < 0) {
        const current = this.outputOffset ?? maxOffset;
        this.outputOffset = Math.max(0, Math.min(maxOffset, current + delta));
      }
      void this.reloadLogs();
    } else {
      const jobs = this.jobs();
      this.selectedIndex = Math.max(0, Math.min(Math.max(0, jobs.length - 1), this.selectedIndex + delta));
      this.selectedListJobId = jobs[this.selectedIndex]?.id;
    }
    this.refresh();
  }

  private jump(to: "start" | "end"): void {
    if (!this.selectedJobId) {
      this.selectedIndex = to === "start" ? 0 : Math.max(0, this.jobs().length - 1);
      this.selectedListJobId = this.jobs()[this.selectedIndex]?.id;
    } else {
      this.outputOffset = to === "start" ? 0 : undefined;
      void this.reloadLogs();
    }
    this.refresh();
  }

  handleInput(data: string): void {
    if (this.filterEditing) {
      if (matchesKey(data, Key.enter)) {
        this.filterQuery = this.filterDraft;
        this.filterEditing = false;
        this.resetListSelection();
        this.refresh();
        return;
      }
      if (matchesKey(data, Key.escape)) {
        this.filterDraft = this.filterQuery;
        this.filterEditing = false;
        this.resetListSelection();
        this.refresh();
        return;
      }
      if (data === "\x7f" || data === "\b") {
        this.filterDraft = Array.from(this.filterDraft).slice(0, -1).join("");
        this.resetListSelection();
        this.refresh();
        return;
      }
      if (isPrintableInput(data)) {
        this.filterDraft += data;
        this.resetListSelection();
        this.refresh();
      }
      return;
    }
    if (data === "/" && !this.selectedJobId) {
      this.filterDraft = "";
      this.filterEditing = true;
      this.confirmationMessage = undefined;
      this.pendingConfirmation = undefined;
      this.resetListSelection();
      this.refresh();
      return;
    }
    if (matchesKey(data, Key.up) || data === "k") {
      this.move(-1);
      return;
    }
    if (matchesKey(data, Key.down) || data === "j") {
      this.move(1);
      return;
    }
    if (data === "g") {
      this.jump("start");
      return;
    }
    if (data === "G") {
      this.jump("end");
      return;
    }
    if (matchesKey(data, Key.enter) && !this.selectedJobId) {
      this.selectedJobId = this.selectedJob()?.id;
      this.outputOffset = undefined;
      this.logPage = undefined;
      void this.reloadLogs();
      this.refresh();
      return;
    }
    if (data === "s") {
      const job = this.selectedJobId ? this.source.get(this.selectedJobId) : this.selectedJob();
      if (job?.status === "running") {
        this.errorMessage = undefined;
        void this.source.stop(job.id)
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            this.errorMessage = `Failed to stop ${job.id}: ${message}`;
          })
          .finally(() => this.refresh());
      }
      return;
    }
    if (data === "d" && !this.selectedJobId) {
      const job = this.selectedJob();
      if (!job || job.status === "running") return;
      const action = `remove:${job.id}`;
      if (this.pendingConfirmation !== action) {
        this.pendingConfirmation = action;
        this.confirmationMessage = `Press d again to remove ${job.id}`;
        this.refresh();
        return;
      }
      this.pendingConfirmation = undefined;
      this.confirmationMessage = undefined;
      void this.source.remove(job.id)
        .catch((error: unknown) => {
          this.errorMessage = `Failed to remove ${job.id}: ${error instanceof Error ? error.message : String(error)}`;
        })
        .finally(() => this.refresh());
      return;
    }
    if (data === "c" && !this.selectedJobId) {
      const completedCount = this.jobs().filter((job) => job.status !== "running").length;
      if (completedCount === 0) return;
      if (this.pendingConfirmation !== "clear-completed") {
        this.pendingConfirmation = "clear-completed";
        this.confirmationMessage = `Press c again to clear ${completedCount} completed ${completedCount === 1 ? "job" : "jobs"}`;
        this.refresh();
        return;
      }
      this.pendingConfirmation = undefined;
      this.confirmationMessage = undefined;
      void this.source.clearCompleted()
        .catch((error: unknown) => {
          this.errorMessage = `Failed to clear completed jobs: ${error instanceof Error ? error.message : String(error)}`;
        })
        .finally(() => this.refresh());
      return;
    }
    if (data === "f" && this.selectedJobId) {
      this.outputOffset = undefined;
      void this.reloadLogs();
      this.refresh();
      return;
    }
    if (data === "r") {
      void this.reloadLogs();
      this.refresh();
      return;
    }
    if (matchesKey(data, Key.escape) || data === "q") {
      if (this.selectedJobId) {
        this.selectedJobId = undefined;
        this.outputOffset = undefined;
        this.logPage = undefined;
        this.refresh();
      } else {
        this.done("close");
      }
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const lines = this.selectedJobId ? this.renderDetail(width) : this.renderList(width);
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  private resetListSelection(): void {
    this.selectedIndex = 0;
    this.selectedListJobId = undefined;
  }

  private add(lines: string[], text: string, width: number): void {
    lines.push(truncateToWidth(text, width));
  }

  private viewportHeight(): number {
    return Math.max(8, this.tui.terminal.rows);
  }

  private outputRows(): number {
    const job = this.selectedJobId ? this.source.get(this.selectedJobId) : undefined;
    const warningRows = (job?.logError ? 2 : 0) + (this.logReadError ? 2 : 0) + (this.errorMessage ? 2 : 0);
    return Math.max(1, this.viewportHeight() - 9 - warningRows);
  }

  private finishView(lines: string[], shortcuts: string, width: number): string[] {
    const contentRows = this.viewportHeight() - 2;
    const visible = lines.slice(0, contentRows);
    while (visible.length < contentRows) visible.push("");
    this.add(visible, this.theme.fg("dim", shortcuts), width);
    this.add(visible, this.theme.fg("accent", "─".repeat(width)), width);
    return visible.map((line) => truncateToWidth(line, width, "…", true));
  }

  private renderList(width: number): string[] {
    const lines: string[] = [];
    const jobs = this.jobs();
    const totalJobs = this.source.list().length;
    const filterActive = this.filterEditing || this.filterQuery.length > 0;
    const count = filterActive ? `${jobs.length}/${totalJobs}` : String(jobs.length);
    this.add(lines, this.theme.fg("accent", ` BACKGROUND PROCESSES  •  Jobs (${count})`), width);
    this.add(lines, this.theme.fg("accent", "─".repeat(width)), width);
    lines.push("");
    if (filterActive) {
      const query = this.filterEditing ? `${this.filterDraft}_` : this.filterQuery;
      this.add(lines, this.theme.fg("accent", ` Filter: ${query}`), width);
      lines.push("");
    }
    if (this.errorMessage) {
      this.add(lines, this.theme.fg("error", ` ${this.errorMessage}`), width);
      lines.push("");
    }

    if (this.confirmationMessage) {
      this.add(lines, this.theme.fg("warning", ` ${this.confirmationMessage}`), width);
      lines.push("");
    }

    if (jobs.length === 0) {
      const message = totalJobs === 0
        ? " No background jobs in this Pi session."
        : " No background jobs match this filter.";
      this.add(lines, this.theme.fg("dim", message), width);
    } else {
      this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, jobs.length - 1));
      const availableRows = Math.max(1, this.viewportHeight() - lines.length - 3);
      const firstVisible = Math.max(0, Math.min(this.selectedIndex, jobs.length - availableRows));
      const lastVisible = Math.min(jobs.length, firstVisible + availableRows);
      for (let index = firstVisible; index < lastVisible; index++) {
        const job = jobs[index]!;
        const selected = index === this.selectedIndex;
        const prefix = selected ? ">" : " ";
        const state = formatJobStatus(job);
        const commandWidth = Math.max(8, width - job.id.length - state.length - 18);
        const displayName = job.label ?? job.command;
        const row = `${prefix} ${job.id}  ${state.padEnd(14)}  ${formatDuration(job.elapsedMs).padStart(7)}  ${truncateCommand(displayName, commandWidth)}`;
        this.add(lines, selected ? this.theme.fg("accent", row) : this.theme.fg("text", row), width);
      }
    }

    const shortcuts = this.filterEditing
      ? " Type to filter • Enter apply • Esc cancel"
      : " ↑↓/jk move • Enter output • / filter • s stop • d delete • c clear • q/Esc close";
    return this.finishView(lines, shortcuts, width);
  }

  private renderDetail(width: number): string[] {
    const lines: string[] = [];
    const job = this.source.get(this.selectedJobId!);
    if (!job) {
      this.selectedJobId = undefined;
      return this.renderList(width);
    }

    const page = this.logPage;
    const offset = page?.offset ?? 0;
    const visible = page?.lines ?? [];

    this.add(lines, this.theme.fg("accent", " BACKGROUND PROCESSES  •  OUTPUT"), width);
    this.add(lines, this.theme.fg("accent", ` ${job.id} • ${job.command}`), width);
    this.add(lines, ` ${formatJobStatus(job)} • PID ${job.pid ?? "—"} • ${formatDuration(job.elapsedMs)} • ${job.cwd}`, width);
    this.add(lines, this.theme.fg("accent", "─".repeat(width)), width);
    lines.push("");
    if (this.errorMessage) {
      this.add(lines, this.theme.fg("error", ` ${this.errorMessage}`), width);
      lines.push("");
    }
    if (job.logError) {
      this.add(lines, this.theme.fg("warning", ` Log warning: ${job.logError}`), width);
      lines.push("");
    }
    if (this.logReadError) {
      this.add(lines, this.theme.fg("error", ` ${this.logReadError}`), width);
      lines.push("");
    }

    if (!page) {
      this.add(lines, this.theme.fg("dim", " Loading output…"), width);
    } else if (visible.length === 0) {
      this.add(lines, this.theme.fg("dim", " No output yet."), width);
    } else {
      for (const line of visible) {
        const stream = line.stream.padEnd(6);
        const color = line.stream === "stderr" ? "warning" : "text";
        this.add(lines, `${this.theme.fg("dim", stream)} │ ${this.theme.fg(color, line.text)}`, width);
      }
    }

    lines.push("");
    const totalLines = page?.totalLines ?? 0;
    const mode = this.outputOffset === undefined ? "FOLLOWING" : "PAUSED";
    this.add(lines, this.theme.fg("dim", ` lines ${totalLines === 0 ? 0 : offset + 1}-${Math.min(totalLines, offset + visible.length)} of ${totalLines} • ${mode}`), width);
    return this.finishView(lines, " ↑↓/jk scroll • f follow • g/G start/end • s stop • r refresh • q/Esc jobs", width);
  }
}

function isPrintableInput(data: string): boolean {
  return data.length > 0 && Array.from(data).every((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint >= 32 && codePoint !== 127;
  });
}
