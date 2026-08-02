import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JobManager } from "../src/job-manager.js";
import type { JobInfo, JobStatus } from "../src/types.js";

function nodeCommand(source: string): string {
  const encoded = Buffer.from(source).toString("base64");
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`eval(Buffer.from('${encoded}','base64').toString())`)}`;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not met before timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function processExists(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("JobManager", () => {
  it("starts explicitly, returns while running, and records stable metadata", async () => {
    const manager = new JobManager();
    try {
      const before = Date.now();
      const job = await manager.start({ command: nodeCommand("setTimeout(() => {}, 300)") });
      const after = Date.now();

      expect(job.id).toMatch(/^bg-[0-9a-f]{12}$/);
      expect(job.status).toBe("running");
      expect(job.command).toContain("-e");
      expect(job.cwd).toBe(process.cwd());
      expect(job.pid).toBeTypeOf("number");
      expect(job.logPath).toContain(job.id);
      expect(Date.parse(job.startedAt)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(job.startedAt)).toBeLessThanOrEqual(after);
      expect(job.endedAt).toBeNull();
      expect(job.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(after - before).toBeLessThan(250);
      expect(manager.get(job.id)).toMatchObject({ id: job.id, status: "running" });
    } finally {
      await manager.cleanup();
    }
  });

  it("preserves a trimmed optional job label", async () => {
    const manager = new JobManager();
    try {
      const job = await manager.start({
        command: nodeCommand("setTimeout(() => {}, 10)"),
        label: " unit tests ",
      });
      expect(job.label).toBe("unit tests");
      expect((await manager.waitForCompletion(job.id)).label).toBe("unit tests");
    } finally {
      await manager.cleanup();
    }
  });

  it("captures interleaved stdout and stderr and reports a real exit code", async () => {
    const manager = new JobManager();
    try {
      const started = await manager.start({
        command: nodeCommand("console.log('hello'); console.error('problem'); process.exitCode = 7"),
      });
      const completed = await manager.waitForCompletion(started.id);
      expect(completed).toMatchObject({ status: "failed", exitCode: 7, signal: null });
      expect(completed.endedAt).not.toBeNull();
      expect(completed.elapsedMs).toBeGreaterThanOrEqual(0);
      const page = await manager.readLog(started.id, { offset: 0, limit: 10 });
      expect(page.lines).toEqual(expect.arrayContaining([
        { stream: "stdout", text: "hello" },
        { stream: "stderr", text: "problem" },
      ]));
    } finally {
      await manager.cleanup();
    }
  });

  it("releases child-process and stream listeners after completion", async () => {
    const manager = new JobManager();
    try {
      const job = await manager.start({ command: nodeCommand("console.log('done')") });
      await manager.waitForCompletion(job.id);
      const runtime = (manager as unknown as { jobs: Map<string, { child: unknown }> }).jobs.get(job.id);
      expect(runtime?.child).toBeNull();
    } finally {
      await manager.cleanup();
    }
  });

  it("records the terminating signal", async () => {
    const manager = new JobManager();
    try {
      const job = await manager.start({ command: nodeCommand("process.kill(process.pid, 'SIGTERM')") });
      const completed = await manager.waitForCompletion(job.id);
      expect(completed).toMatchObject({ status: "exited", exitCode: null, signal: "SIGTERM" });
    } finally {
      await manager.cleanup();
    }
  });

  it("validates command, timeout, and cwd before spawning", async () => {
    const manager = new JobManager();
    const fileDir = await mkdtemp(join(tmpdir(), "bg-invalid-cwd-"));
    const file = join(fileDir, "file");
    await import("node:fs/promises").then(({ writeFile }) => writeFile(file, "x"));
    try {
      await expect(manager.start({ command: "   " })).rejects.toThrow("command");
      await expect(manager.start({ command: "echo ok", timeoutMs: 0 })).rejects.toThrow("timeoutMs");
      await expect(manager.start({ command: "echo ok", cwd: join(fileDir, "missing") })).rejects.toThrow("cwd");
      await expect(manager.start({ command: "echo ok", cwd: file })).rejects.toThrow("directory");
      expect(manager.list()).toEqual([]);
    } finally {
      await manager.cleanup();
      await rm(fileDir, { recursive: true, force: true });
    }
  });

  it("marks jobs timed out and escalates from SIGTERM to SIGKILL", async () => {
    const manager = new JobManager({ killGraceMs: 30 });
    try {
      const job = await manager.start({
        command: nodeCommand("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"),
        timeoutMs: 80,
      });
      const completed = await manager.waitForCompletion(job.id);
      expect(completed.status).toBe("timed_out");
      expect(["SIGTERM", "SIGKILL"]).toContain(completed.signal);
      expect(completed.elapsedMs).toBeGreaterThanOrEqual(80);
    } finally {
      await manager.cleanup();
    }
  });

  it("returns from graceful stop without waiting for the force-kill grace period", async () => {
    const manager = new JobManager({ killGraceMs: 1_000 });
    try {
      const job = await manager.start({ command: nodeCommand("setInterval(() => {}, 1000)") });
      const before = Date.now();
      await manager.stop(job.id);
      expect(Date.now() - before).toBeLessThan(500);
      expect(manager.get(job.id)?.status).toBe("stopped");
    } finally {
      await manager.cleanup();
    }
  });

  it("stops idempotently and kills the whole detached POSIX process group", async () => {
    if (process.platform === "win32") return;
    const manager = new JobManager({ killGraceMs: 40 });
    const dir = await mkdtemp(join(tmpdir(), "bg-process-group-"));
    const childPidFile = join(dir, "child.pid");
    try {
      const source = `
        const { spawn } = require('node:child_process');
        const { writeFileSync } = require('node:fs');
        const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: 'ignore' });
        writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid));
        setInterval(() => {}, 1000);
      `;
      const job = await manager.start({ command: nodeCommand(source), cwd: dir });
      await waitUntil(() => {
        try { return Boolean(Number(requireRead(childPidFile))); } catch { return false; }
      });
      const childPid = Number(await readFile(childPidFile, "utf8"));
      await Promise.all([manager.stop(job.id), manager.stop(job.id)]);
      expect(manager.get(job.id)?.status).toBe("stopped");
      await waitUntil(() => !processExistsSync(childPid));
      expect(await processExists(childPid)).toBe(false);
    } finally {
      await manager.cleanup();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("cleans process-group descendants when the shell exits first", async () => {
    if (process.platform === "win32") return;
    const manager = new JobManager({ killGraceMs: 40 });
    const dir = await mkdtemp(join(tmpdir(), "bg-orphan-group-"));
    const childPidFile = join(dir, "child.pid");
    try {
      const source = `
        const { spawn } = require('node:child_process');
        const { writeFileSync } = require('node:fs');
        const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: 'inherit' });
        child.unref();
        writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid));
      `;
      const job = await manager.start({ command: nodeCommand(source), cwd: dir });
      const completed = await manager.waitForCompletion(job.id);
      const childPid = Number(await readFile(childPidFile, "utf8"));
      expect(completed).toMatchObject({ status: "exited", exitCode: 0 });
      await waitUntil(() => !processRunningSync(childPid));
      expect(processRunningSync(childPid)).toBe(false);
    } finally {
      await manager.cleanup();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stopAll stops every session-owned running job", async () => {
    const manager = new JobManager({ killGraceMs: 20 });
    try {
      const one = await manager.start({ command: nodeCommand("setInterval(() => {}, 1000)") });
      const two = await manager.start({ command: nodeCommand("setInterval(() => {}, 1000)") });
      await manager.stopAll();
      expect(manager.get(one.id)?.status).toBe("stopped");
      expect(manager.get(two.id)?.status).toBe("stopped");
    } finally {
      await manager.cleanup();
    }
  });

  it("removes completed jobs and refuses to remove running jobs", async () => {
    const manager = new JobManager();
    try {
      const completed = await manager.start({ command: nodeCommand("console.log('done')") });
      await manager.waitForCompletion(completed.id);
      const running = await manager.start({ command: nodeCommand("setInterval(() => {}, 1000)") });

      expect(await manager.remove(running.id)).toBe(false);
      expect(await manager.remove(completed.id)).toBe(true);
      expect(manager.get(completed.id)).toBeUndefined();
      expect(manager.get(running.id)?.status).toBe("running");
    } finally {
      await manager.cleanup();
    }
  });

  it("clears every completed job while retaining running jobs", async () => {
    const manager = new JobManager();
    try {
      const first = await manager.start({ command: nodeCommand("process.exit(0)") });
      const second = await manager.start({ command: nodeCommand("process.exit(1)") });
      await Promise.all([manager.waitForCompletion(first.id), manager.waitForCompletion(second.id)]);
      const running = await manager.start({ command: nodeCommand("setInterval(() => {}, 1000)") });

      expect(await manager.clearCompleted()).toBe(2);
      expect(manager.list()).toEqual([expect.objectContaining({ id: running.id, status: "running" })]);
    } finally {
      await manager.cleanup();
    }
  });

  it("surfaces asynchronous log write failures on the job", async () => {
    const logStore = {
      createLog: async () => "/tmp/failing-log.jsonl",
      append: async () => { throw new Error("disk full"); },
      closeLog: async () => undefined,
      read: async () => ({ offset: 0, limit: 100, lines: [], totalLines: 0, hasMore: false, nextOffset: null }),
      remove: async () => undefined,
      cleanup: async () => undefined,
    };
    const manager = new JobManager({ logStore: logStore as never });
    try {
      const job = await manager.start({ command: nodeCommand("console.log('lost')") });
      await manager.waitForCompletion(job.id);
      await waitUntil(() => typeof manager.get(job.id)?.logError === "string");
      expect(manager.get(job.id)?.logError).toContain("disk full");
    } finally {
      await manager.cleanup();
    }
  });

  it("reports spawn failures and invokes lifecycle and completion callbacks", async () => {
    const statuses: JobStatus[] = [];
    const completed: JobInfo[] = [];
    const manager = new JobManager({
      shell: join(tmpdir(), "shell-that-does-not-exist"),
      onChange: (job) => statuses.push(job.status),
      onComplete: (job) => completed.push(job),
    });
    try {
      const job = await manager.start({ command: "echo never" });
      const result = await manager.waitForCompletion(job.id);
      expect(result.status).toBe("failed");
      expect(statuses).toContain("running");
      expect(statuses.at(-1)).toBe("failed");
      expect(completed).toHaveLength(1);
      expect(completed[0]?.id).toBe(job.id);
    } finally {
      await manager.cleanup();
    }
  });
});

function requireRead(path: string): string {
  return readFileSync(path, "utf8");
}

function processRunningSync(pid: number): boolean {
  try {
    const status = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim();
    return status.length > 0 && !status.startsWith("Z");
  } catch {
    return false;
  }
}

function processExistsSync(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
