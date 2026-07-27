import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatJobStatus, formatStatusLine } from "./format.js";
import { JobManager, type JobManagerOptions } from "./job-manager.js";
import { registerBackgroundBashTools } from "./tools.js";
import type { JobInfo } from "./types.js";
import { BackgroundJobsBrowser, type BackgroundJobsDataSource } from "./ui.js";

const STATUS_KEY = "background-bash";
const RESULT_MESSAGE_TYPE = "background-bash-result";

export interface BackgroundBashExtensionDependencies {
  createManager?(options: JobManagerOptions): JobManager;
}

export function createBackgroundBashExtension(dependencies: BackgroundBashExtensionDependencies = {}) {
  return function backgroundBashExtension(pi: ExtensionAPI): void {
    const createManager = dependencies.createManager ?? ((options: JobManagerOptions) => new JobManager(options));
    const notifyAgentByJobId = new Map<string, boolean>();
    const listeners = new Set<() => void>();
    let latestContext: ExtensionContext | undefined;
    let sessionStarted = false;
    let shuttingDown = false;
    let manager: JobManager;

    const emit = () => {
      for (const listener of listeners) listener();
    };

    const updateStatus = () => {
      const ctx = latestContext;
      if (!ctx?.hasUI) return;
      const text = formatStatusLine(manager.list());
      ctx.ui.setStatus(STATUS_KEY, text ? ctx.ui.theme.fg("accent", text) : undefined);
    };

    const handleCompletion = (job: JobInfo) => {
      updateStatus();
      emit();
      const notifyAgent = notifyAgentByJobId.get(job.id) ?? false;
      notifyAgentByJobId.delete(job.id);
      if (shuttingDown) return;

      const ctx = latestContext;
      const successful = job.status === "exited" && job.exitCode === 0;
      if (ctx?.hasUI) {
        ctx.ui.notify(
          `${job.id} completed: ${formatJobStatus(job)}. Open /background-bash to inspect output.`,
          successful ? "info" : "warning",
        );
      }
      if (!notifyAgent) return;

      const content = [
        `Background Bash job ${job.id} completed.`,
        `Status: ${formatJobStatus(job)}`,
        `Command: ${job.command}`,
        `Working directory: ${job.cwd}`,
        `Elapsed: ${job.elapsedMs}ms`,
        "Use background_bash_logs for complete output.",
      ].join("\n");
      pi.sendMessage(
        { customType: RESULT_MESSAGE_TYPE, content, display: true, details: job },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    };

    const newManager = () => createManager({
      onChange: () => {
        updateStatus();
        emit();
      },
      onComplete: handleCompletion,
    });
    manager = newManager();

    const dataSource: BackgroundJobsDataSource = {
      list: () => manager.list(),
      get: (id) => manager.get(id),
      readLogs: (id, options) => manager.readLog(id, options),
      stop: (id) => manager.stop(id),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };

    registerBackgroundBashTools(pi, {
      getManager: () => manager,
      onJobStarted: (job, notifyAgent) => {
        notifyAgentByJobId.set(job.id, notifyAgent);
        updateStatus();
        emit();
      },
    });

    pi.registerCommand("background-bash", {
      description: "Browse background Bash jobs and their output",
      handler: async (_args, ctx) => {
        latestContext = ctx;
        if (ctx.mode !== "tui") {
          ctx.ui.notify("/background-bash requires Pi's interactive TUI.", "error");
          return;
        }
        await ctx.ui.custom<"close">((tui, theme, _keybindings, done) =>
          new BackgroundJobsBrowser(tui, theme, dataSource, done));
      },
    });

    pi.on("session_start", async (_event, ctx) => {
      latestContext = ctx;
      if (sessionStarted) {
        shuttingDown = true;
        await manager.cleanup();
        notifyAgentByJobId.clear();
        manager = newManager();
      }
      shuttingDown = false;
      sessionStarted = true;
      updateStatus();
    });

    pi.on("session_shutdown", async (_event, ctx) => {
      latestContext = ctx;
      shuttingDown = true;
      await manager.cleanup();
      notifyAgentByJobId.clear();
      listeners.clear();
      if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
      latestContext = undefined;
    });
  };
}

export default createBackgroundBashExtension();
