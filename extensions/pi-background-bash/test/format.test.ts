import { describe, expect, it } from "vitest";
import { formatDuration, formatJobStatus, formatWidgetSummary, truncateCommand } from "../src/format.js";
import type { JobInfo } from "../src/types.js";

function job(overrides: Partial<JobInfo> = {}): JobInfo {
  return {
    id: "bg-1234abcd",
    command: "npm test",
    cwd: "/repo",
    status: "running",
    startedAt: "2026-07-27T00:00:00.000Z",
    endedAt: null,
    pid: 123,
    logPath: "/tmp/job.log",
    exitCode: null,
    signal: null,
    elapsedMs: 1_500,
    timeoutMs: null,
    ...overrides,
  };
}

describe("background bash formatting", () => {
  it.each([
    [0, "0s"],
    [1_500, "1s"],
    [65_000, "1m 5s"],
    [3_665_000, "1h 1m"],
  ])("formats %i milliseconds", (milliseconds, expected) => {
    expect(formatDuration(milliseconds)).toBe(expected);
  });

  it("formats the newest running command for the task-focused widget", () => {
    const jobs = [
      job({ id: "bg-old", command: "npm run build", elapsedMs: 8_000 }),
      job({ id: "bg-done", status: "exited", exitCode: 0 }),
      job({ id: "bg-new", command: "npm test", elapsedMs: 1_500 }),
    ];
    expect(formatWidgetSummary(jobs)).toEqual({
      command: "npm test",
      status: "running",
      statusColor: "accent",
      duration: "1s",
      additionalRunning: 1,
    });
    expect(formatWidgetSummary([])).toBeUndefined();
  });

  it("shows the latest completed command with a semantic status color", () => {
    expect(formatWidgetSummary([
      job({ id: "bg-passed", command: "npm test", status: "exited", exitCode: 0 }),
      job({ id: "bg-failed", command: "npm run build", status: "failed", exitCode: 2, elapsedMs: 8_000 }),
    ])).toEqual({
      command: "npm run build",
      status: "failed 2",
      statusColor: "error",
      duration: "8s",
      additionalRunning: 0,
    });
  });

  it("renders distinct final states", () => {
    expect(formatJobStatus(job({ status: "exited", exitCode: 0 }))).toBe("exited 0");
    expect(formatJobStatus(job({ status: "failed", exitCode: 2 }))).toBe("failed 2");
    expect(formatJobStatus(job({ status: "timed_out", signal: "SIGTERM" }))).toBe("timed out • SIGTERM");
    expect(formatJobStatus(job({ status: "stopped", signal: "SIGKILL" }))).toBe("stopped • SIGKILL");
  });

  it("truncates long commands without exceeding the requested width", () => {
    expect(truncateCommand("npm run a-very-long-command", 12)).toBe("npm run a-v…");
    expect(truncateCommand("short", 12)).toBe("short");
  });
});
