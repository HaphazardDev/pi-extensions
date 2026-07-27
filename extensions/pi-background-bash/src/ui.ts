import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { formatDuration, formatJobStatus, truncateCommand } from "./format.js";
import type { JobInfo, LogPage } from "./types.js";

const OUTPUT_ROWS = 18;
const POLL_INTERVAL_MS = 750;

export interface BackgroundJobsDataSource {
  list(): JobInfo[];
  get(id: string): JobInfo | undefined;
  readLogs(id: string, options?: { offset?: number; limit?: number }): Promise<LogPage>;
  stop(id: string): Promise<unknown>;
  subscribe(listener: () => void): () => void;
}

export class BackgroundJobsBrowser {
  private selectedIndex = 0;
  private selectedJobId: string | undefined;
  private outputOffset: number | undefined;
  private logPage: LogPage | undefined;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;
  private readonly unsubscribe: () => void;
  private readonly pollTimer: NodeJS.Timeout;
  private reloadGeneration = 0;
  private errorMessage: string | undefined;
  private disposed = false;

  constructor(
    private readonly tui: { requestRender(): void },
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
      const maxOffset = Math.max(0, summary.totalLines - OUTPUT_ROWS);
      const offset = Math.max(0, Math.min(maxOffset, this.outputOffset ?? maxOffset));
      const page = await this.source.readLogs(id, { offset, limit: OUTPUT_ROWS });
      if (this.disposed || this.selectedJobId !== id || generation !== this.reloadGeneration) return;
      this.logPage = page;
      this.refresh();
    } catch {
      // The job may disappear during session shutdown; the next list render handles it.
    }
  }

  private jobs(): JobInfo[] {
    return this.source.list();
  }

  private selectedJob(): JobInfo | undefined {
    const jobs = this.jobs();
    if (jobs.length === 0) return undefined;
    this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, jobs.length - 1));
    return jobs[this.selectedIndex];
  }

  private move(delta: number): void {
    if (this.selectedJobId) {
      const maxOffset = Math.max(0, (this.logPage?.totalLines ?? 0) - OUTPUT_ROWS);
      const current = this.outputOffset ?? maxOffset;
      this.outputOffset = Math.max(0, Math.min(maxOffset, current + delta));
      void this.reloadLogs();
    } else {
      const jobs = this.jobs();
      this.selectedIndex = Math.max(0, Math.min(Math.max(0, jobs.length - 1), this.selectedIndex + delta));
    }
    this.refresh();
  }

  private jump(to: "start" | "end"): void {
    if (!this.selectedJobId) {
      this.selectedIndex = to === "start" ? 0 : Math.max(0, this.jobs().length - 1);
    } else {
      const totalLines = this.logPage?.totalLines ?? 0;
      this.outputOffset = to === "start" ? 0 : Math.max(0, totalLines - OUTPUT_ROWS);
      void this.reloadLogs();
    }
    this.refresh();
  }

  handleInput(data: string): void {
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

  private add(lines: string[], text: string, width: number): void {
    lines.push(truncateToWidth(text, width));
  }

  private renderList(width: number): string[] {
    const lines: string[] = [];
    const jobs = this.jobs();
    this.add(lines, this.theme.fg("accent", "─".repeat(width)), width);
    this.add(lines, this.theme.fg("accent", ` Background Bash Jobs (${jobs.length})`), width);
    lines.push("");
    if (this.errorMessage) {
      this.add(lines, this.theme.fg("error", ` ${this.errorMessage}`), width);
      lines.push("");
    }

    if (jobs.length === 0) {
      this.add(lines, this.theme.fg("dim", " No background jobs in this Pi session."), width);
    } else {
      this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, jobs.length - 1));
      for (let index = 0; index < jobs.length; index++) {
        const job = jobs[index]!;
        const selected = index === this.selectedIndex;
        const prefix = selected ? ">" : " ";
        const state = formatJobStatus(job);
        const commandWidth = Math.max(8, width - job.id.length - state.length - 18);
        const row = `${prefix} ${job.id}  ${state.padEnd(14)}  ${formatDuration(job.elapsedMs).padStart(7)}  ${truncateCommand(job.command, commandWidth)}`;
        this.add(lines, selected ? this.theme.fg("accent", row) : this.theme.fg("text", row), width);
      }
    }

    lines.push("");
    this.add(lines, this.theme.fg("dim", " ↑↓/jk navigate • Enter output • s stop • r refresh • q/Esc close"), width);
    this.add(lines, this.theme.fg("accent", "─".repeat(width)), width);
    return lines;
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

    this.add(lines, this.theme.fg("accent", "─".repeat(width)), width);
    this.add(lines, this.theme.fg("accent", ` ${job.id} • ${job.command}`), width);
    this.add(lines, ` ${formatJobStatus(job)} • PID ${job.pid ?? "—"} • ${formatDuration(job.elapsedMs)} • ${job.cwd}`, width);
    lines.push("");
    if (this.errorMessage) {
      this.add(lines, this.theme.fg("error", ` ${this.errorMessage}`), width);
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
    this.add(lines, this.theme.fg("dim", ` lines ${totalLines === 0 ? 0 : offset + 1}-${Math.min(totalLines, offset + visible.length)} of ${totalLines}`), width);
    this.add(lines, this.theme.fg("dim", " ↑↓/jk scroll • g/G start/end • s stop • r refresh • q/Esc jobs"), width);
    this.add(lines, this.theme.fg("accent", "─".repeat(width)), width);
    return lines;
  }
}
