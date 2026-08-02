import { describe, expect, it, vi } from "vitest";
import { BackgroundJobsBrowser, type BackgroundJobsDataSource } from "../src/ui.js";
import type { JobInfo, LogPage } from "../src/types.js";

function job(overrides: Partial<JobInfo> = {}): JobInfo {
  return {
    id: "bg-one",
    command: "npm run dev",
    cwd: "/repo",
    status: "running",
    startedAt: "2026-07-27T00:00:00.000Z",
    endedAt: null,
    pid: 123,
    logPath: "/tmp/bg-one.log",
    exitCode: null,
    signal: null,
    elapsedMs: 1_500,
    timeoutMs: null,
    ...overrides,
  };
}

function source(jobs = [job(), job({ id: "bg-two", command: "npm test", status: "exited", exitCode: 0 })]) {
  let listener: (() => void) | undefined;
  const pages = new Map<string, LogPage>([
    ["bg-one", { offset: 0, limit: 200, lines: [{ stream: "stdout", text: "server ready" }], totalLines: 1, hasMore: false, nextOffset: null }],
    ["bg-two", { offset: 0, limit: 200, lines: [{ stream: "stderr", text: "test warning" }, { stream: "stdout", text: "tests passed" }], totalLines: 2, hasMore: false, nextOffset: null }],
  ]);

  const dataSource: BackgroundJobsDataSource & { emit: () => void } = {
    list: vi.fn(() => jobs),
    get: vi.fn((id: string) => jobs.find((candidate) => candidate.id === id)),
    readLogs: vi.fn(async (id: string, options?: { offset?: number; limit?: number }) => {
      const page = pages.get(id)!;
      return { ...page, offset: options?.offset ?? page.offset, limit: options?.limit ?? page.limit };
    }),
    stop: vi.fn(async (_id: string) => true),
    remove: vi.fn(async (id: string) => {
      const index = jobs.findIndex((candidate) => candidate.id === id);
      if (index < 0 || jobs[index]?.status === "running") return false;
      jobs.splice(index, 1);
      listener?.();
      return true;
    }),
    clearCompleted: vi.fn(async () => {
      let removed = 0;
      for (let index = jobs.length - 1; index >= 0; index--) {
        if (jobs[index]?.status !== "running") {
          jobs.splice(index, 1);
          removed += 1;
        }
      }
      listener?.();
      return removed;
    }),
    subscribe: vi.fn((callback: () => void) => {
      listener = callback;
      return () => {
        listener = undefined;
      };
    }),
    emit: () => listener?.(),
  };
  return dataSource;
}

const theme = {
  fg: (_color: string, text: string) => text,
};

function tui(rows = 24) {
  return { requestRender: vi.fn(), terminal: { rows } };
}

describe("BackgroundJobsBrowser", () => {
  it("renders a navigable list with running and completed jobs", () => {
    const browser = new BackgroundJobsBrowser(tui() as any, theme as any, source(), vi.fn());
    const lines = browser.render(100);
    const output = lines.join("\n");

    expect(lines).toHaveLength(24);
    expect(lines.every((line) => line.length === 100)).toBe(true);
    expect(lines[0]).toContain("BACKGROUND PROCESSES");
    expect(lines.at(-2)).toContain("↑↓/jk move");
    expect(lines.at(-2)).toContain("/ filter");
    expect(lines.at(-2)).toContain("d delete");
    expect(lines.at(-2)).toContain("c clear");
    expect(lines.at(-2)).not.toContain("r refresh");
    expect(output).toContain("Jobs (2)");
    expect(output).toContain("> bg-one");
    expect(output).toContain("running");
    expect(output).toContain("bg-two");
    expect(output).toContain("exited 0");
  });

  it("orders running jobs first, newest first, and initially selects the newest running job", () => {
    const dataSource = source([
      job({ id: "bg-old-complete", status: "exited", startedAt: "2026-07-27T00:00:00.000Z" }),
      job({ id: "bg-old-running", startedAt: "2026-07-27T00:01:00.000Z" }),
      job({ id: "bg-new-running", label: "unit tests", command: "npm test", startedAt: "2026-07-27T00:02:00.000Z" }),
      job({ id: "bg-new-complete", status: "failed", startedAt: "2026-07-27T00:03:00.000Z" }),
    ]);
    const browser = new BackgroundJobsBrowser(tui() as any, theme as any, dataSource, vi.fn());
    const output = browser.render(100).join("\n");

    expect(output.indexOf("bg-new-running")).toBeLessThan(output.indexOf("bg-old-running"));
    expect(output.indexOf("bg-old-running")).toBeLessThan(output.indexOf("bg-new-complete"));
    expect(output).toContain("> bg-new-running");
    expect(output).toContain("unit tests");
  });

  it("requires a second keypress before deleting one completed job", async () => {
    const dataSource = source([
      job({ id: "bg-running" }),
      job({ id: "bg-complete", status: "exited", exitCode: 0 }),
    ]);
    const browser = new BackgroundJobsBrowser(tui() as any, theme as any, dataSource, vi.fn());
    browser.handleInput("j");

    browser.handleInput("d");
    expect(dataSource.remove).not.toHaveBeenCalled();
    expect(browser.render(100).join("\n")).toContain("Press d again to remove bg-complete");

    browser.handleInput("d");
    await vi.waitFor(() => expect(dataSource.remove).toHaveBeenCalledWith("bg-complete"));
    expect(browser.render(100).join("\n")).not.toContain("bg-complete");
  });

  it("requires confirmation before clearing all completed jobs", async () => {
    const dataSource = source([
      job({ id: "bg-running" }),
      job({ id: "bg-passed", status: "exited", exitCode: 0 }),
      job({ id: "bg-failed", status: "failed", exitCode: 1 }),
    ]);
    const browser = new BackgroundJobsBrowser(tui() as any, theme as any, dataSource, vi.fn());

    browser.handleInput("c");
    expect(dataSource.clearCompleted).not.toHaveBeenCalled();
    expect(browser.render(100).join("\n")).toContain("Press c again to clear 2 completed jobs");

    browser.handleInput("c");
    await vi.waitFor(() => expect(dataSource.clearCompleted).toHaveBeenCalledOnce());
    const output = browser.render(100).join("\n");
    expect(output).toContain("bg-running");
    expect(output).not.toContain("bg-passed");
    expect(output).not.toContain("bg-failed");
  });

  it("filters live by status, command, ID, or label and supports apply/cancel editing", () => {
    const dataSource = source([
      job({ id: "bg-server", label: "development server", command: "npm run dev" }),
      job({ id: "bg-unit", label: "unit tests", command: "npm test", status: "exited", exitCode: 0 }),
      job({ id: "bg-build", command: "npm run build", status: "failed", exitCode: 1 }),
    ]);
    const browser = new BackgroundJobsBrowser(tui() as any, theme as any, dataSource, vi.fn());

    browser.handleInput("/");
    for (const character of "failed") browser.handleInput(character);
    let output = browser.render(100).join("\n");
    expect(output).toContain("Filter: failed_");
    expect(output).toContain("Jobs (1/3)");
    expect(output).toContain("bg-build");
    expect(output).not.toContain("bg-server");

    browser.handleInput("\x7f");
    expect(browser.render(100).join("\n")).toContain("Filter: faile_");
    browser.handleInput("d");
    browser.handleInput("\r");
    expect(browser.render(100).join("\n")).toContain("Filter: failed");

    browser.handleInput("/");
    for (const character of "unit tests") browser.handleInput(character);
    output = browser.render(100).join("\n");
    expect(output).toContain("bg-unit");
    expect(output).not.toContain("bg-build");
    browser.handleInput("\x1b");
    output = browser.render(100).join("\n");
    expect(output).toContain("Filter: failed");
    expect(output).toContain("bg-build");
  });

  it("shows a clear empty state when no jobs match the filter", () => {
    const browser = new BackgroundJobsBrowser(tui() as any, theme as any, source(), vi.fn());
    browser.handleInput("/");
    for (const character of "not-present") browser.handleInput(character);
    expect(browser.render(100).join("\n")).toContain("No background jobs match this filter.");
  });

  it("uses raw arrow and enter input to open the selected job output", async () => {
    const browser = new BackgroundJobsBrowser(tui() as any, theme as any, source(), vi.fn());

    browser.handleInput("\x1b[B");
    browser.handleInput("\r");
    await vi.waitFor(() => expect(browser.render(100).join("\n")).toContain("tests passed"));
    const output = browser.render(100).join("\n");
    const lines = browser.render(100);

    expect(lines).toHaveLength(24);
    expect(lines[0]).toContain("BACKGROUND PROCESSES  •  OUTPUT");
    expect(lines.at(-2)).toContain("↑↓/jk scroll");
    expect(output).toContain("bg-two • npm test");
    expect(output).toContain("stderr │ test warning");
    expect(output).toContain("stdout │ tests passed");
  });

  it("loads the tail of logs larger than the UI page limit", async () => {
    const running = job();
    const lines = Array.from({ length: 2_005 }, (_, index) => ({ stream: "stdout" as const, text: `line ${index + 1}` }));
    const dataSource: BackgroundJobsDataSource = {
      list: () => [running],
      get: () => running,
      readLogs: vi.fn(async (_id: string, options = {}) => {
        const offset = options.offset ?? 0;
        const limit = options.limit ?? 100;
        const pageLines = lines.slice(offset, offset + limit);
        return {
          offset,
          limit,
          lines: pageLines,
          totalLines: lines.length,
          hasMore: offset + pageLines.length < lines.length,
          nextOffset: offset + pageLines.length < lines.length ? offset + pageLines.length : null,
        };
      }),
      stop: vi.fn(async () => true),
      remove: vi.fn(async () => false),
      clearCompleted: vi.fn(async () => 0),
      subscribe: () => () => undefined,
    };
    const browser = new BackgroundJobsBrowser(tui() as any, theme as any, dataSource, vi.fn());

    browser.handleInput("\r");
    await vi.waitFor(() => expect(browser.render(100).join("\n")).toContain("line 2005"));
    expect(dataSource.readLogs).toHaveBeenCalledWith("bg-one", { offset: 1_989, limit: 16 });
    browser.dispose();
  });

  it("returns from detail before closing the browser", () => {
    const done = vi.fn();
    const browser = new BackgroundJobsBrowser(tui() as any, theme as any, source(), done);

    browser.handleInput("\r");
    browser.handleInput("\x1b");
    expect(done).not.toHaveBeenCalled();
    expect(browser.render(100).join("\n")).toContain("BACKGROUND PROCESSES");

    browser.handleInput("q");
    expect(done).toHaveBeenCalledWith("close");
  });

  it("stops the selected running job", async () => {
    const dataSource = source();
    const browser = new BackgroundJobsBrowser(tui() as any, theme as any, dataSource, vi.fn());

    browser.handleInput("s");
    await Promise.resolve();

    expect(dataSource.stop).toHaveBeenCalledWith("bg-one");
  });

  it("surfaces stop failures without an unhandled rejection", async () => {
    const dataSource = source();
    const stopMock = dataSource.stop as unknown as { mockRejectedValue(error: unknown): void };
    stopMock.mockRejectedValue(new Error("permission denied"));
    const browser = new BackgroundJobsBrowser(tui() as any, theme as any, dataSource, vi.fn());

    browser.handleInput("s");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(browser.render(100).join("\n")).toContain("Failed to stop");
    browser.dispose();
  });

  it("rerenders on job changes and unsubscribes when disposed", () => {
    const requestRender = vi.fn();
    const dataSource = source();
    const browser = new BackgroundJobsBrowser({ requestRender, terminal: { rows: 24 } } as any, theme as any, dataSource, vi.fn());

    dataSource.emit();
    expect(requestRender).toHaveBeenCalled();

    browser.dispose();
    requestRender.mockClear();
    dataSource.emit();
    expect(requestRender).not.toHaveBeenCalled();
  });
});
