import { describe, expect, it, vi } from "vitest";
import { createMockContext, createMockPi, createMockUi } from "../../test-utils/pi.js";
import { createBackgroundBashExtension } from "../src/index.js";
import type { JobManagerOptions } from "../src/job-manager.js";
import type { JobInfo } from "../src/types.js";

function job(overrides: Partial<JobInfo> = {}): JobInfo {
  return {
    id: "bg-one",
    command: "npm test",
    cwd: "/repo",
    status: "running",
    startedAt: "2026-07-27T00:00:00.000Z",
    endedAt: null,
    pid: 123,
    logPath: "/tmp/bg-one.jsonl",
    exitCode: null,
    signal: null,
    elapsedMs: 500,
    timeoutMs: null,
    ...overrides,
  };
}

function setup() {
  const jobs: JobInfo[] = [];
  const managers: any[] = [];
  const createManager = vi.fn((options: JobManagerOptions) => {
    const manager = {
      options,
      start: vi.fn(async ({ command, cwd, timeoutMs }: any) => {
        const created = job({ command, cwd, timeoutMs: timeoutMs ?? null });
        jobs.push(created);
        options.onChange?.(created);
        return created;
      }),
      list: vi.fn(() => [...jobs]),
      get: vi.fn((id: string) => jobs.find((candidate) => candidate.id === id)),
      readLog: vi.fn(async () => ({ offset: 0, limit: 100, lines: [], totalLines: 0, hasMore: false, nextOffset: null })),
      stop: vi.fn(async () => true),
      cleanup: vi.fn(async () => undefined),
    };
    managers.push(manager);
    return manager as any;
  });
  const pi = createMockPi();
  createBackgroundBashExtension({ createManager })(pi);
  return { pi, createManager, managers, jobs };
}

describe("pi-background-bash extension", () => {
  it("registers lifecycle tools, the browser command, and session handlers", () => {
    const { pi } = setup();
    expect(pi.tools).toHaveLength(5);
    expect(pi.commands.get("ps")).toBeDefined();
    expect(pi.commands.get("background-bash")).toBeUndefined();
    expect(pi.shortcuts.get("ctrl+alt+k")).toBeDefined();
    expect(pi.handlers.get("session_start")).toHaveLength(1);
    expect(pi.handlers.get("session_shutdown")).toHaveLength(1);
  });

  it("shows running and total counts above the editor when manager state changes", async () => {
    const { pi, managers, jobs } = setup();
    const ui = createMockUi();
    const ctx = createMockContext({ ui, cwd: "/repo", mode: "tui" });
    await pi.handlers.get("session_start")[0]({ type: "session_start", reason: "startup" }, ctx);

    const running = job();
    jobs.push(running);
    managers[0].options.onChange(running);
    expect(ui.setWidget).toHaveBeenLastCalledWith(
      "background-bash",
      ["⚙ 1 running • 1 job • /ps"],
      { placement: "aboveEditor" },
    );
    expect(ui.setStatus).not.toHaveBeenCalled();
  });

  it("opens the navigable TUI browser from /ps", async () => {
    const { pi, jobs } = setup();
    jobs.push(job());
    const ui = createMockUi({ custom: vi.fn().mockResolvedValue("close") });
    const ctx = createMockContext({ ui, cwd: "/repo", mode: "tui" });
    await pi.handlers.get("session_start")[0]({ type: "session_start", reason: "startup" }, ctx);

    await pi.commands.get("ps").handler("", ctx);

    expect(ui.custom).toHaveBeenCalledWith(expect.any(Function), {
      overlay: true,
      overlayOptions: { col: 0, margin: 0, maxHeight: "100%", row: 0, width: "100%" },
    });
    const factory = ui.custom.mock.calls[0][0];
    const component = factory({ requestRender: vi.fn(), terminal: { rows: 24 } }, ui.theme, {}, vi.fn());
    expect(component.render(100).join("\n")).toContain("bg-one");
    component.dispose();
  });

  it("opens the navigable TUI browser from Ctrl+Alt+K", async () => {
    const { pi, jobs } = setup();
    jobs.push(job());
    const ui = createMockUi({ custom: vi.fn().mockResolvedValue("close") });
    const ctx = createMockContext({ ui, cwd: "/repo", mode: "tui" });
    await pi.handlers.get("session_start")[0]({ type: "session_start", reason: "startup" }, ctx);

    await pi.shortcuts.get("ctrl+alt+k").handler(ctx);

    expect(ui.custom).toHaveBeenCalledWith(expect.any(Function), {
      overlay: true,
      overlayOptions: { col: 0, margin: 0, maxHeight: "100%", row: 0, width: "100%" },
    });
    const factory = ui.custom.mock.calls[0][0];
    const component = factory({ requestRender: vi.fn(), terminal: { rows: 24 } }, ui.theme, {}, vi.fn());
    expect(component.render(100).join("\n")).toContain("bg-one");
    component.dispose();
  });

  it("wakes the agent with a structured completion result when requested", async () => {
    const { pi, managers } = setup();
    const ctx = createMockContext({ cwd: "/repo", mode: "tui" });
    await pi.handlers.get("session_start")[0]({ type: "session_start", reason: "startup" }, ctx);
    const start = pi.tools.find((candidate: any) => candidate.name === "background_bash_start");
    await start.execute("start", { command: "npm test" }, undefined, undefined, ctx);

    managers[0].options.onComplete(job({ status: "exited", exitCode: 0, endedAt: "2026-07-27T00:00:01.000Z" }));

    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "background-bash-result", content: expect.stringContaining("bg-one"), display: true }),
      { triggerTurn: true, deliverAs: "followUp" },
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("completed"), "info");
  });

  it("does not wake the agent when notifyAgent is false", async () => {
    const { pi, managers } = setup();
    const ctx = createMockContext({ cwd: "/repo", mode: "tui" });
    await pi.handlers.get("session_start")[0]({ type: "session_start", reason: "startup" }, ctx);
    const start = pi.tools.find((candidate: any) => candidate.name === "background_bash_start");
    await start.execute("start", { command: "npm test", notifyAgent: false }, undefined, undefined, ctx);

    managers[0].options.onComplete(job({ status: "exited", exitCode: 0 }));
    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalled();
  });

  it("suppresses cleanup completion notifications during shutdown", async () => {
    const { pi, managers } = setup();
    const ui = createMockUi();
    const ctx = createMockContext({ ui, cwd: "/repo", mode: "tui" });
    await pi.handlers.get("session_start")[0]({ type: "session_start", reason: "startup" }, ctx);
    managers[0].cleanup.mockImplementation(async () => {
      managers[0].options.onComplete(job({ status: "stopped", signal: "SIGTERM" }));
    });

    await pi.handlers.get("session_shutdown")[0]({ type: "session_shutdown" }, ctx);

    expect(ui.notify).not.toHaveBeenCalled();
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("cleans running jobs and clears the above-editor widget at shutdown", async () => {
    const { pi, managers } = setup();
    const ui = createMockUi();
    const ctx = createMockContext({ ui, cwd: "/repo", mode: "tui" });
    await pi.handlers.get("session_start")[0]({ type: "session_start", reason: "startup" }, ctx);

    await pi.handlers.get("session_shutdown")[0]({ type: "session_shutdown" }, ctx);

    expect(managers[0].cleanup).toHaveBeenCalledOnce();
    expect(ui.setWidget).toHaveBeenLastCalledWith("background-bash", undefined);
  });
});
