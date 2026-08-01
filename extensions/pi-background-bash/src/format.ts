import type { JobInfo } from "./types.js";

export function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) return `${totalMinutes}m ${seconds}s`;

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

export function truncateCommand(command: string, width: number): string {
  if (width <= 0) return "";
  if (command.length <= width) return command;
  if (width === 1) return "…";
  return `${command.slice(0, width - 1)}…`;
}

export function formatJobStatus(job: JobInfo): string {
  if (job.status === "running") return "running";

  const label = job.status === "timed_out" ? "timed out" : job.status;
  if (job.exitCode !== null) return `${label} ${job.exitCode}`;
  if (job.signal) return `${label} • ${job.signal}`;
  return label;
}

export interface WidgetSummary {
  command: string;
  status: string;
  statusColor: "accent" | "success" | "error" | "warning" | "muted";
  duration: string;
  additionalRunning: number;
}

function widgetStatus(job: JobInfo): Pick<WidgetSummary, "status" | "statusColor"> {
  if (job.status === "running") return { status: "running", statusColor: "accent" };
  if (job.status === "exited" && job.exitCode === 0) return { status: "passed", statusColor: "success" };
  if (job.status === "timed_out") return { status: "timed out", statusColor: "warning" };
  if (job.status === "stopped") return { status: "stopped", statusColor: "muted" };
  return { status: formatJobStatus(job), statusColor: "error" };
}

export function formatWidgetSummary(jobs: JobInfo[]): WidgetSummary | undefined {
  if (jobs.length === 0) return undefined;
  const running = jobs.filter((job) => job.status === "running");
  const selected = [...running].reverse().at(0) ?? jobs.at(-1)!;
  return {
    command: truncateCommand(selected.command, 48),
    ...widgetStatus(selected),
    duration: formatDuration(selected.elapsedMs),
    additionalRunning: Math.max(0, running.length - 1),
  };
}
