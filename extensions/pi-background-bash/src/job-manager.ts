import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { LogStore, type LogStoreOptions } from "./log-store.js";
import type {
  JobInfo,
  JobLifecycleCallback,
  JobStatus,
  LogPage,
  StartJobOptions,
} from "./types.js";

export interface JobManagerOptions extends LogStoreOptions {
  killGraceMs?: number;
  shell?: string;
  onChange?: JobLifecycleCallback;
  onComplete?: JobLifecycleCallback;
  logStore?: LogStore;
}

interface JobRuntime {
  job: JobInfo;
  child: ChildProcess | null;
  startedMs: number;
  intent: "stopped" | "timed_out" | null;
  timeoutTimer: NodeJS.Timeout | null;
  escalationTimer: NodeJS.Timeout | null;
  escalationPromise: Promise<void> | null;
  resolveEscalation: (() => void) | null;
  exitCleanupPromise: Promise<void> | null;
  completion: Promise<JobInfo>;
  resolveCompletion: (job: JobInfo) => void;
  finalized: boolean;
}

export class JobManager {
  readonly logStore: LogStore;
  private readonly jobs = new Map<string, JobRuntime>();
  private readonly killGraceMs: number;
  private readonly shell: string;
  private readonly onChange?: JobLifecycleCallback;
  private readonly onComplete?: JobLifecycleCallback;
  private cleaned = false;

  constructor(options: JobManagerOptions = {}) {
    if (process.platform === "win32") {
      throw new Error("pi-background-bash currently supports macOS and Linux only");
    }
    if (!Number.isFinite(options.killGraceMs ?? 1_000) || (options.killGraceMs ?? 1_000) < 0) {
      throw new Error("killGraceMs must be a non-negative number");
    }
    this.killGraceMs = options.killGraceMs ?? 1_000;
    this.shell = options.shell ?? defaultShell();
    this.onChange = options.onChange;
    this.onComplete = options.onComplete;
    this.logStore = options.logStore ?? new LogStore(options);
  }

  async start(options: StartJobOptions): Promise<JobInfo> {
    if (this.cleaned) throw new Error("job manager has been cleaned up");
    const command = options.command;
    if (typeof command !== "string" || command.trim().length === 0) {
      throw new Error("command must be a non-empty string");
    }
    const label = options.label?.trim() || undefined;
    if (label && label.length > 80) throw new Error("label must not exceed 80 characters");
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
      throw new Error("timeoutMs must be a positive number");
    }
    const cwd = resolve(options.cwd ?? process.cwd());
    let cwdStat;
    try {
      cwdStat = await stat(cwd);
    } catch {
      throw new Error(`cwd does not exist: ${cwd}`);
    }
    if (!cwdStat.isDirectory()) throw new Error(`cwd must be a directory: ${cwd}`);

    const id = this.createId();
    const logPath = await this.logStore.createLog(id);
    const startedMs = Date.now();
    const startedAt = new Date(startedMs).toISOString();
    const child = spawn(this.shell, shellArguments(command), {
      cwd,
      env: process.env,
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const job: JobInfo = {
      id,
      ...(label ? { label } : {}),
      command,
      cwd,
      status: "running",
      startedAt,
      endedAt: null,
      pid: child.pid ?? null,
      logPath,
      exitCode: null,
      signal: null,
      elapsedMs: 0,
      timeoutMs: options.timeoutMs ?? null,
    };
    let resolveCompletion!: (job: JobInfo) => void;
    const completion = new Promise<JobInfo>((resolvePromise) => {
      resolveCompletion = resolvePromise;
    });
    const runtime: JobRuntime = {
      job,
      child,
      startedMs,
      intent: null,
      timeoutTimer: null,
      escalationTimer: null,
      escalationPromise: null,
      resolveEscalation: null,
      exitCleanupPromise: null,
      completion,
      resolveCompletion,
      finalized: false,
    };
    this.jobs.set(id, runtime);

    child.stdout?.on("data", (chunk: Buffer) => {
      void this.logStore.append(logPath, "stdout", chunk).catch(() => undefined);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      void this.logStore.append(logPath, "stderr", chunk).catch(() => undefined);
    });
    child.once("error", (error) => {
      void this.logStore.append(logPath, "stderr", `${error.message}\n`).catch(() => undefined);
      void this.finalize(runtime, "failed", null, null);
    });
    child.once("exit", () => {
      runtime.exitCleanupPromise = this.cleanupAfterRootExit(runtime);
    });
    child.once("close", (code, signal) => {
      void this.handleClose(runtime, code, signal);
    });

    if (options.timeoutMs !== undefined) {
      runtime.timeoutTimer = setTimeout(() => {
        void this.requestStop(runtime, "timed_out");
      }, options.timeoutMs);
      runtime.timeoutTimer.unref();
    }
    this.emitChange(job);
    return this.snapshot(runtime);
  }

  get(id: string): JobInfo | undefined {
    const runtime = this.jobs.get(id);
    return runtime ? this.snapshot(runtime) : undefined;
  }

  list(): JobInfo[] {
    return [...this.jobs.values()].map((runtime) => this.snapshot(runtime));
  }

  async readLog(id: string, options: { offset?: number; limit?: number } = {}): Promise<LogPage> {
    const runtime = this.requireJob(id);
    return this.logStore.read(runtime.job.logPath, options);
  }

  async waitForCompletion(id: string): Promise<JobInfo> {
    return this.requireJob(id).completion;
  }

  async stop(id: string): Promise<boolean> {
    const runtime = this.requireJob(id);
    if (runtime.job.status !== "running") return false;
    await this.requestStop(runtime, "stopped");
    return true;
  }

  async stopAll(): Promise<void> {
    await Promise.all(
      [...this.jobs.values()]
        .filter((runtime) => runtime.job.status === "running")
        .map((runtime) => this.requestStop(runtime, "stopped")),
    );
  }

  async cleanup(): Promise<void> {
    if (this.cleaned) return;
    this.cleaned = true;
    await this.stopAll();
    await Promise.all([...this.jobs.values()].map((runtime) => runtime.completion));
    await this.logStore.cleanup();
  }

  private async cleanupAfterRootExit(runtime: JobRuntime): Promise<void> {
    if (runtime.intent === null && this.groupExists(runtime)) {
      await this.terminateRemainingGroup(runtime);
    }
  }

  private async handleClose(
    runtime: JobRuntime,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    await runtime.exitCleanupPromise;
    if (runtime.intent === null && this.groupExists(runtime)) {
      await this.terminateRemainingGroup(runtime);
    }
    const status: JobStatus = runtime.intent ?? (code !== null && code !== 0 ? "failed" : "exited");
    await this.finalize(runtime, status, code, signal);
  }

  private async terminateRemainingGroup(runtime: JobRuntime): Promise<void> {
    this.signal(runtime, "SIGTERM");
    const deadline = Date.now() + this.killGraceMs;
    while (this.groupExists(runtime) && Date.now() < deadline) {
      await delay(Math.min(20, Math.max(1, deadline - Date.now())));
    }
    if (this.groupExists(runtime)) this.signal(runtime, "SIGKILL");
  }

  private async requestStop(runtime: JobRuntime, intent: "stopped" | "timed_out"): Promise<void> {
    if (runtime.intent === null && runtime.job.status === "running") {
      runtime.intent = intent;
      this.signal(runtime, "SIGTERM");
      runtime.escalationPromise = new Promise<void>((resolvePromise) => {
        runtime.resolveEscalation = resolvePromise;
        runtime.escalationTimer = setTimeout(() => {
          if (this.groupExists(runtime)) this.signal(runtime, "SIGKILL");
          this.finishEscalation(runtime);
        }, this.killGraceMs);
      });
    }
    await Promise.all([runtime.completion, runtime.escalationPromise ?? Promise.resolve()]);
  }

  private finishEscalation(runtime: JobRuntime): void {
    if (runtime.escalationTimer) {
      clearTimeout(runtime.escalationTimer);
      runtime.escalationTimer = null;
    }
    const resolveEscalation = runtime.resolveEscalation;
    runtime.resolveEscalation = null;
    resolveEscalation?.();
  }

  private signal(runtime: JobRuntime, signal: NodeJS.Signals): void {
    const pid = runtime.job.pid;
    if (pid === null) return;
    try {
      if (process.platform === "win32") runtime.child?.kill(signal);
      else process.kill(-pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }

  private groupExists(runtime: JobRuntime): boolean {
    const pid = runtime.job.pid;
    if (pid === null) return false;
    try {
      if (process.platform === "win32") {
        const child = runtime.child;
        return child !== null && child.exitCode === null && child.signalCode === null;
      }
      process.kill(-pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private async finalize(
    runtime: JobRuntime,
    status: JobStatus,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    if (runtime.finalized) return;
    runtime.finalized = true;
    if (runtime.timeoutTimer) {
      clearTimeout(runtime.timeoutTimer);
      runtime.timeoutTimer = null;
    }
    if (!this.groupExists(runtime)) this.finishEscalation(runtime);
    await this.logStore.closeLog(runtime.job.logPath).catch(() => undefined);
    this.releaseChild(runtime);
    const endedMs = Date.now();
    runtime.job.status = status;
    runtime.job.exitCode = code;
    runtime.job.signal = signal;
    runtime.job.endedAt = new Date(endedMs).toISOString();
    runtime.job.elapsedMs = endedMs - runtime.startedMs;
    const snapshot = this.snapshot(runtime);
    this.emitChange(snapshot);
    this.safeCallback(this.onComplete, snapshot);
    runtime.resolveCompletion(snapshot);
  }

  private releaseChild(runtime: JobRuntime): void {
    const child = runtime.child;
    if (!child) return;
    child.stdout?.removeAllListeners();
    child.stderr?.removeAllListeners();
    child.removeAllListeners();
    runtime.child = null;
  }

  private snapshot(runtime: JobRuntime): JobInfo {
    const job = { ...runtime.job };
    if (job.status === "running") job.elapsedMs = Date.now() - runtime.startedMs;
    return job;
  }

  private emitChange(job: JobInfo): void {
    this.safeCallback(this.onChange, { ...job });
  }

  private safeCallback(callback: JobLifecycleCallback | undefined, job: JobInfo): void {
    try {
      callback?.({ ...job });
    } catch {
      // Lifecycle observers cannot disrupt process cleanup.
    }
  }

  private requireJob(id: string): JobRuntime {
    const runtime = this.jobs.get(id);
    if (!runtime) throw new Error(`unknown session job: ${id}`);
    return runtime;
  }

  private createId(): string {
    let id: string;
    do {
      id = `bg-${randomBytes(6).toString("hex")}`;
    } while (this.jobs.has(id));
    return id;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function defaultShell(): string {
  if (process.platform === "win32") return process.env.ComSpec ?? "cmd.exe";
  return process.env.SHELL ?? "/bin/sh";
}

function shellArguments(command: string): string[] {
  if (process.platform === "win32") return ["/d", "/s", "/c", command];
  return ["-c", command];
}
