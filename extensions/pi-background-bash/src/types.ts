export type LogStream = "stdout" | "stderr";

export interface LogLine {
  stream: LogStream;
  text: string;
}

export interface LogPage {
  offset: number;
  limit: number;
  lines: LogLine[];
  totalLines: number;
  hasMore: boolean;
  nextOffset: number | null;
}

export type JobStatus = "running" | "exited" | "failed" | "timed_out" | "stopped";

export interface StartJobOptions {
  command: string;
  label?: string;
  cwd?: string;
  timeoutMs?: number;
}

export interface JobInfo {
  id: string;
  label?: string;
  command: string;
  cwd: string;
  status: JobStatus;
  startedAt: string;
  endedAt: string | null;
  pid: number | null;
  logPath: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  elapsedMs: number;
  timeoutMs: number | null;
  logError?: string | null;
}

export type JobLifecycleCallback = (job: JobInfo) => void;
