import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { JobManager } from "./job-manager.js";
import type { JobInfo, LogPage } from "./types.js";

export interface RegisterBackgroundBashToolsOptions {
  getManager(): Pick<JobManager, "start" | "list" | "get" | "readLog" | "stop">;
  onJobStarted?(job: JobInfo, notifyAgent: boolean): void;
}

const IdParams = Type.Object({
  id: Type.String({ description: "Background Bash job ID, such as bg-a1b2c3d4" }),
});

function textResult<T>(text: string, details: T) {
  return { content: [{ type: "text" as const, text }], details };
}

function requireJob(manager: Pick<JobManager, "get">, id: string): JobInfo {
  const job = manager.get(id);
  if (!job) throw new Error(`Unknown background Bash job: ${id}`);
  return job;
}

function formatLogPage(page: LogPage): string {
  if (page.lines.length === 0) return `No output at offset ${page.offset}.`;
  const body = page.lines.map((line) => `${line.stream.padEnd(6)} │ ${line.text}`).join("\n");
  const rangeEnd = page.offset + page.lines.length;
  return `${body}\n\nLines ${page.offset + 1}-${rangeEnd} of ${page.totalLines}${page.hasMore ? `; continue at offset ${page.nextOffset}` : ""}.`;
}

export function registerBackgroundBashTools(pi: ExtensionAPI, options: RegisterBackgroundBashToolsOptions): void {
  pi.registerTool({
    name: "background_bash_start",
    label: "Start Background Bash",
    description:
      "Start an explicit background shell command and return immediately. This is a shell-semantic tool: pi-permission-system users must map it in shellTools with commandArgument=command and workdirArgument=cwd for native Bash policy parity.",
    promptSnippet: "Start an explicit session-owned background shell job without blocking the current turn.",
    promptGuidelines: [
      "Use built-in bash for ordinary foreground commands and background_bash_start only when work should continue concurrently.",
      "Use background_bash_status or background_bash_logs instead of retrying a command merely to wait for it.",
      "Background jobs belong to this Pi process and are stopped when the session shuts down; use tmux or a service manager for durable processes.",
    ],
    parameters: Type.Object({
      command: Type.String({ minLength: 1, description: "Shell command to run" }),
      label: Type.Optional(Type.String({ maxLength: 80, description: "Optional human-readable job label" })),
      cwd: Type.Optional(Type.String({ minLength: 1, description: "Working directory; defaults to Pi's current cwd" })),
      timeoutSeconds: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "Stop the job after this many seconds" })),
      notifyAgent: Type.Optional(Type.Boolean({ description: "Wake the agent with a completion result; defaults to true" })),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("Background Bash start was aborted before spawning.");
      const manager = options.getManager();
      const job = await manager.start({
        command: params.command,
        label: params.label?.trim() || undefined,
        cwd: params.cwd?.trim() || ctx.cwd,
        timeoutMs: params.timeoutSeconds === undefined ? undefined : params.timeoutSeconds * 1_000,
      });
      options.onJobStarted?.(job, params.notifyAgent ?? true);
      return textResult(
        `Started ${job.id} (PID ${job.pid ?? "unknown"}) in ${job.cwd}. Use background_bash_status or background_bash_logs to inspect it.`,
        job,
      );
    },
  });

  pi.registerTool({
    name: "background_bash_list",
    label: "List Background Bash Jobs",
    description: "List background shell jobs owned by this Pi process.",
    parameters: Type.Object({}),
    executionMode: "parallel",
    async execute() {
      const jobs = options.getManager().list();
      const text = jobs.length === 0
        ? "No background Bash jobs in this Pi session."
        : jobs.map((job) => `${job.id} • ${job.status} • PID ${job.pid ?? "—"} • ${job.command}`).join("\n");
      return textResult(text, jobs);
    },
  });

  pi.registerTool({
    name: "background_bash_status",
    label: "Background Bash Status",
    description: "Read current status, timing, process, and exit metadata for one background shell job.",
    parameters: IdParams,
    executionMode: "parallel",
    async execute(_toolCallId, params) {
      const job = requireJob(options.getManager(), params.id);
      return textResult(
        `${job.id} is ${job.status}; PID ${job.pid ?? "—"}; elapsed ${job.elapsedMs}ms; exit ${job.exitCode ?? "—"}; signal ${job.signal ?? "—"}.`,
        job,
      );
    },
  });

  pi.registerTool({
    name: "background_bash_logs",
    label: "Read Background Bash Logs",
    description: "Read a bounded page of stdout/stderr lines for one background shell job.",
    parameters: Type.Object({
      id: IdParams.properties.id,
      offset: Type.Optional(Type.Integer({ minimum: 0, description: "Zero-based line offset" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000, description: "Maximum lines to return" })),
    }),
    executionMode: "parallel",
    async execute(_toolCallId, params) {
      const manager = options.getManager();
      requireJob(manager, params.id);
      const page = await manager.readLog(params.id, { offset: params.offset, limit: params.limit });
      return textResult(formatLogPage(page), page);
    },
  });

  pi.registerTool({
    name: "background_bash_stop",
    label: "Stop Background Bash Job",
    description: "Gracefully stop a background shell job and its process group. Repeated stops are safe.",
    parameters: IdParams,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const manager = options.getManager();
      requireJob(manager, params.id);
      const stopped = await manager.stop(params.id);
      const job = requireJob(manager, params.id);
      return textResult(
        stopped ? `Stopped ${params.id}.` : `${params.id} was already ${job.status}.`,
        { stopped, job },
      );
    },
  });
}
