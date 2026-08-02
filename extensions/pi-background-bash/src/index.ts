import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatJobStatus, formatWidgetSummary } from "./format.js";
import { JobManager, type JobManagerOptions } from "./job-manager.js";
import { registerBackgroundBashTools } from "./tools.js";
import type { JobInfo } from "./types.js";
import { BackgroundJobsBrowser, type BackgroundJobsDataSource } from "./ui.js";

const WIDGET_KEY = "background-bash";
const RESULT_MESSAGE_TYPE = "background-bash-result";
const BACKGROUND_JOB_ICON = "";

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
    let widgetRefreshTimer: NodeJS.Timeout | undefined;
    let manager: JobManager;

    const emit = () => {
      for (const listener of listeners) listener();
    };

    const updateWidget = () => {
      const ctx = latestContext;
      if (!ctx?.hasUI) return;
      const summary = formatWidgetSummary(manager.list());
      if (!summary) {
        ctx.ui.setWidget(WIDGET_KEY, undefined);
        return;
      }
      const separator = ctx.ui.theme.fg("dim", " • ");
      const fields = [
        `${ctx.ui.theme.fg("dim", BACKGROUND_JOB_ICON)} ${ctx.ui.theme.fg("text", summary.command)}`,
        `${ctx.ui.theme.fg(summary.statusColor, summary.status)} ${ctx.ui.theme.fg("dim", summary.duration)}`,
      ];
      if (summary.additionalRunning > 0) {
        fields.push(ctx.ui.theme.fg("accent", `+${summary.additionalRunning} more`));
      }
      fields.push(ctx.ui.theme.fg("accent", "/ps"));
      ctx.ui.setWidget(
        WIDGET_KEY,
        [fields.join(separator)],
        { placement: "aboveEditor" },
      );
    };

    const handleCompletion = (job: JobInfo) => {
      updateWidget();
      emit();
      const notifyAgent = notifyAgentByJobId.get(job.id) ?? false;
      notifyAgentByJobId.delete(job.id);
      if (shuttingDown) return;

      const ctx = latestContext;
      const successful = job.status === "exited" && job.exitCode === 0;
      if (ctx?.hasUI) {
        ctx.ui.notify(
          `${job.id} completed: ${formatJobStatus(job)}. Open /ps to inspect output.`,
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
        updateWidget();
        emit();
      },
      onComplete: handleCompletion,
    });
    manager = newManager();

    const startWidgetRefresh = () => {
      if (widgetRefreshTimer) return;
      widgetRefreshTimer = setInterval(() => {
        if (manager.list().some((job) => job.status === "running")) updateWidget();
      }, 1_000);
      widgetRefreshTimer.unref();
    };

    const stopWidgetRefresh = () => {
      if (!widgetRefreshTimer) return;
      clearInterval(widgetRefreshTimer);
      widgetRefreshTimer = undefined;
    };

    const dataSource: BackgroundJobsDataSource = {
      list: () => manager.list(),
      get: (id) => manager.get(id),
      readLogs: (id, options) => manager.readLog(id, options),
      stop: (id) => manager.stop(id),
      remove: (id) => manager.remove(id),
      clearCompleted: () => manager.clearCompleted(),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };

    const openBrowser = async (ctx: ExtensionContext): Promise<void> => {
      latestContext = ctx;
      if (ctx.mode !== "tui") {
        ctx.ui.notify("The background process browser requires Pi's interactive TUI.", "error");
        return;
      }
      await ctx.ui.custom<"close">(
        (tui, theme, _keybindings, done) => new BackgroundJobsBrowser(tui, theme, dataSource, done),
        {
          overlay: true,
          overlayOptions: { col: 0, margin: 0, maxHeight: "100%", row: 0, width: "100%" },
        },
      );
    };

    registerBackgroundBashTools(pi, {
      getManager: () => manager,
      onJobStarted: (job, notifyAgent) => {
        notifyAgentByJobId.set(job.id, notifyAgent);
        updateWidget();
        emit();
      },
    });

    pi.registerCommand("ps", {
      description: "Browse background Bash jobs and their output",
      handler: async (_args, ctx) => openBrowser(ctx),
    });

    pi.registerShortcut("ctrl+alt+k", {
      description: "Open background Bash jobs",
      handler: openBrowser,
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
      startWidgetRefresh();
      updateWidget();
    });

    pi.on("session_shutdown", async (_event, ctx) => {
      latestContext = ctx;
      shuttingDown = true;
      stopWidgetRefresh();
      await manager.cleanup();
      notifyAgentByJobId.clear();
      listeners.clear();
      if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
      latestContext = undefined;
    });
  };
}

export default createBackgroundBashExtension();
