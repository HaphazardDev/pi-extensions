import { describe, expect, it } from "vitest";
import { formatDuration, formatJobStatus, formatStatusLine, truncateCommand } from "../src/format.js";
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

  it("reports running and total job counts", () => {
    const jobs = [job(), job({ id: "bg-done", status: "exited", exitCode: 0 })];
    expect(formatStatusLine(jobs)).toBe("⚙ 1 running • 2 jobs • /background-bash");
    expect(formatStatusLine([])).toBeUndefined();
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
