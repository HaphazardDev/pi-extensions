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

export function formatWidgetLines(jobs: JobInfo[]): string[] | undefined {
  if (jobs.length === 0) return undefined;
  const running = jobs.filter((job) => job.status === "running").length;
  const runningLabel = `${running} running`;
  const jobsLabel = `${jobs.length} ${jobs.length === 1 ? "job" : "jobs"}`;
  return [`⚙ ${runningLabel} • ${jobsLabel} • /ps`];
}
