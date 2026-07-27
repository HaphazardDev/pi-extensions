import { describe, expect, it, vi } from "vitest";
import { createMockContext, createMockPi } from "../../test-utils/pi.js";
import { registerBackgroundBashTools } from "../src/tools.js";
import type { JobInfo, LogPage } from "../src/types.js";

function job(overrides: Partial<JobInfo> = {}): JobInfo {
  return {
    id: "bg-abc123",
    command: "npm test",
    cwd: "/repo",
    status: "running",
    startedAt: "2026-07-27T00:00:00.000Z",
    endedAt: null,
    pid: 123,
    logPath: "/tmp/bg-abc123.jsonl",
    exitCode: null,
    signal: null,
    elapsedMs: 10,
    timeoutMs: null,
    ...overrides,
  };
}

function setup() {
  const running = job();
  const page: LogPage = {
    offset: 0,
    limit: 100,
    lines: [{ stream: "stdout", text: "ok" }],
    totalLines: 1,
    hasMore: false,
    nextOffset: null,
  };
  const manager = {
    start: vi.fn(async () => running),
    list: vi.fn(() => [running]),
    get: vi.fn((id: string) => id === running.id ? running : undefined),
    readLog: vi.fn(async () => page),
    stop: vi.fn(async () => true),
  };
  const onJobStarted = vi.fn();
  const pi = createMockPi();
  registerBackgroundBashTools(pi, { getManager: () => manager as any, onJobStarted });
  return { pi, manager, onJobStarted, running, page };
}

function tool(pi: ReturnType<typeof createMockPi>, name: string) {
  return pi.tools.find((candidate: any) => candidate.name === name);
}

describe("background Bash tools", () => {
  it("registers the complete lifecycle surface", () => {
    const { pi } = setup();
    expect(pi.tools.map((candidate: any) => candidate.name)).toEqual([
      "background_bash_start",
      "background_bash_list",
      "background_bash_status",
      "background_bash_logs",
      "background_bash_stop",
    ]);
  });

  it("marks only the start tool as carrying shell semantics in its guidance", () => {
    const { pi } = setup();
    const start = tool(pi, "background_bash_start");
    expect(start.description).toContain("shellTools");
    expect(start.parameters.properties.command).toBeDefined();
    expect(start.parameters.properties.cwd).toBeDefined();
    expect(start.promptGuidelines.join(" ")).toContain("built-in bash");
  });

  it("starts with the context cwd, converts timeout seconds, and records notification preference", async () => {
    const { pi, manager, onJobStarted, running } = setup();
    const ctx = createMockContext({ cwd: "/context" });

    const result = await tool(pi, "background_bash_start").execute(
      "call-1",
      { command: "npm test", timeoutSeconds: 12, notifyAgent: false },
      undefined,
      undefined,
      ctx,
    );

    expect(manager.start).toHaveBeenCalledWith({ command: "npm test", cwd: "/context", timeoutMs: 12_000 });
    expect(onJobStarted).toHaveBeenCalledWith(running, false);
    expect(result.content[0].text).toContain("bg-abc123");
    expect(result.details).toEqual(running);
  });

  it("rejects an already-aborted start before spawning", async () => {
    const { pi, manager } = setup();
    const controller = new AbortController();
    controller.abort();

    await expect(tool(pi, "background_bash_start").execute(
      "call-1",
      { command: "npm test" },
      controller.signal,
      undefined,
      createMockContext({ cwd: "/repo" }),
    )).rejects.toThrow("aborted");
    expect(manager.start).not.toHaveBeenCalled();
  });

  it("lists, inspects, reads logs, and stops jobs", async () => {
    const { pi, manager, running, page } = setup();
    const ctx = createMockContext();

    const listResult = await tool(pi, "background_bash_list").execute("list", {}, undefined, undefined, ctx);
    expect(listResult.details).toEqual([running]);

    const statusResult = await tool(pi, "background_bash_status").execute("status", { id: running.id }, undefined, undefined, ctx);
    expect(statusResult.details).toEqual(running);

    const logsResult = await tool(pi, "background_bash_logs").execute("logs", { id: running.id, offset: 2, limit: 25 }, undefined, undefined, ctx);
    expect(manager.readLog).toHaveBeenCalledWith(running.id, { offset: 2, limit: 25 });
    expect(logsResult.details).toEqual(page);
    expect(logsResult.content[0].text).toContain("stdout │ ok");

    const stopResult = await tool(pi, "background_bash_stop").execute("stop", { id: running.id }, undefined, undefined, ctx);
    expect(manager.stop).toHaveBeenCalledWith(running.id);
    expect(stopResult.details).toMatchObject({ stopped: true, job: running });
  });

  it("reports unknown job IDs clearly", async () => {
    const { pi } = setup();
    await expect(tool(pi, "background_bash_status").execute(
      "status",
      { id: "bg-missing" },
      undefined,
      undefined,
      createMockContext(),
    )).rejects.toThrow("Unknown background Bash job: bg-missing");
  });
});
