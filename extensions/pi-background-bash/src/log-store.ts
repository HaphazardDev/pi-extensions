import { createReadStream, mkdtempSync } from "node:fs";
import { mkdir, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import type { LogLine, LogPage, LogStream } from "./types.js";

export interface LogStoreOptions {
  maxPageLimit?: number;
  defaultPageLimit?: number;
  maxLineCharacters?: number;
  maxPageCharacters?: number;
}

interface PendingLog {
  stdout: string;
  stderr: string;
  decoders: Record<LogStream, StringDecoder>;
  writeChain: Promise<void>;
  bytesQueued: number;
  totalRecords: number;
  closed: boolean;
}

const DEFAULT_PAGE_LIMIT = 100;
const DEFAULT_MAX_PAGE_LIMIT = 1_000;
const DEFAULT_MAX_LINE_CHARACTERS = 8_192;
const DEFAULT_MAX_PAGE_CHARACTERS = 64_000;
const CHECKPOINT_INTERVAL = 1_024;
const CHECKPOINT_BYTES = 8;

export class LogStore {
  readonly directory: string;
  readonly maxPageLimit: number;
  readonly defaultPageLimit: number;
  readonly maxLineCharacters: number;
  readonly maxPageCharacters: number;
  private readonly pending = new Map<string, PendingLog>();
  private cleaned = false;

  constructor(options: LogStoreOptions = {}) {
    this.maxPageLimit = positiveInteger(options.maxPageLimit ?? DEFAULT_MAX_PAGE_LIMIT, "maxPageLimit");
    this.defaultPageLimit = Math.min(
      positiveInteger(options.defaultPageLimit ?? DEFAULT_PAGE_LIMIT, "defaultPageLimit"),
      this.maxPageLimit,
    );
    this.maxPageCharacters = positiveInteger(
      options.maxPageCharacters ?? DEFAULT_MAX_PAGE_CHARACTERS,
      "maxPageCharacters",
    );
    this.maxLineCharacters = Math.min(
      positiveInteger(options.maxLineCharacters ?? DEFAULT_MAX_LINE_CHARACTERS, "maxLineCharacters"),
      this.maxPageCharacters,
    );
    this.directory = mkdtempSync(join(tmpdir(), "pi-background-bash-"));
  }

  async createLog(jobId: string): Promise<string> {
    this.assertOpen();
    if (!jobId || basename(jobId) !== jobId) {
      throw new Error("jobId must be a non-empty file-safe name");
    }
    await mkdir(this.directory, { recursive: true });
    const path = join(this.directory, `${jobId}.jsonl`);
    await writeFile(path, "", { flag: "wx" });
    await writeFile(indexPath(path), Buffer.alloc(0), { flag: "wx" });
    await writeFile(partialPath(path), JSON.stringify({ stdout: "", stderr: "" }), { flag: "wx" });
    this.pending.set(path, {
      stdout: "",
      stderr: "",
      decoders: { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") },
      writeChain: Promise.resolve(),
      bytesQueued: 0,
      totalRecords: 0,
      closed: false,
    });
    return path;
  }

  async append(path: string, stream: LogStream, chunk: string | Uint8Array): Promise<void> {
    this.assertOpen();
    const state = this.requireLog(path);
    if (state.closed) throw new Error("log is closed");
    const text = typeof chunk === "string" ? chunk : state.decoders[stream].write(Buffer.from(chunk));
    const consumed = consumeText(stream, state[stream] + text, this.maxLineCharacters);
    state[stream] = consumed.partial;
    this.queueRecords(path, state, consumed.records);
    await state.writeChain;
  }

  async closeLog(path: string): Promise<void> {
    const state = this.requireLog(path);
    if (state.closed) {
      await state.writeChain;
      return;
    }
    state.closed = true;
    const records: LogLine[] = [];
    for (const stream of ["stdout", "stderr"] as const) {
      const consumed = consumeText(
        stream,
        state[stream] + state.decoders[stream].end(),
        this.maxLineCharacters,
      );
      records.push(...consumed.records);
      if (consumed.partial.length > 0) records.push({ stream, text: consumed.partial });
      state[stream] = "";
    }
    this.queueRecords(path, state, records);
    await state.writeChain;
  }

  async read(
    path: string,
    options: { offset?: number; limit?: number } = {},
  ): Promise<LogPage> {
    const offset = nonNegativeInteger(options.offset ?? 0, "offset");
    const requestedLimit = positiveInteger(options.limit ?? this.defaultPageLimit, "limit");
    const limit = Math.min(requestedLimit, this.maxPageLimit);
    const state = this.requireLog(path);
    const snapshotRecords = state.totalRecords;
    const partialRecords = (["stdout", "stderr"] as const)
      .filter((stream) => state[stream].length > 0)
      .map((stream) => ({ stream, text: state[stream] }));
    const snapshotWrite = state.writeChain;
    await snapshotWrite;

    const totalLines = snapshotRecords + partialRecords.length;
    const lines: LogLine[] = [];
    let characters = 0;

    const add = (record: LogLine): boolean => {
      if (lines.length >= limit) return false;
      if (lines.length > 0 && characters + record.text.length > this.maxPageCharacters) return false;
      lines.push(record);
      characters += record.text.length;
      return true;
    };

    if (offset < snapshotRecords) {
      const checkpointRecord = Math.floor(offset / CHECKPOINT_INTERVAL) * CHECKPOINT_INTERVAL;
      const checkpointOffset = await readCheckpoint(path, checkpointRecord / CHECKPOINT_INTERVAL);
      const input = createReadStream(path, {
        encoding: "utf8",
        start: checkpointOffset,
      });
      const reader = createInterface({ input, crlfDelay: Infinity });
      let index = checkpointRecord;
      try {
        for await (const serialized of reader) {
          if (index >= snapshotRecords) break;
          if (index >= offset && !add(JSON.parse(serialized) as LogLine)) break;
          index += 1;
          if (lines.length >= limit) break;
        }
      } finally {
        reader.close();
        input.destroy();
      }
    }

    if (lines.length < limit && characters < this.maxPageCharacters) {
      for (let index = 0; index < partialRecords.length; index += 1) {
        const absoluteIndex = snapshotRecords + index;
        if (absoluteIndex < offset) continue;
        if (!add(partialRecords[index]!)) break;
      }
    }

    const next = offset + lines.length;
    const hasMore = next < totalLines;
    return {
      offset,
      limit,
      lines,
      totalLines,
      hasMore,
      nextOffset: hasMore ? next : null,
    };
  }

  async remove(path: string): Promise<void> {
    const state = this.requireLog(path);
    if (!state.closed) throw new Error("cannot remove an open log");
    const [writeResult] = await Promise.allSettled([state.writeChain]);
    this.pending.delete(path);
    await Promise.all([
      rm(path, { force: true }),
      rm(indexPath(path), { force: true }),
      rm(partialPath(path), { force: true }),
    ]);
    if (writeResult?.status === "rejected") throw writeResult.reason;
  }

  async cleanup(): Promise<void> {
    if (this.cleaned) return;
    this.cleaned = true;
    const results = await Promise.allSettled([...this.pending.keys()].map((path) => this.closeLog(path)));
    this.pending.clear();
    await rm(this.directory, { recursive: true, force: true });
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
  }

  private queueRecords(path: string, state: PendingLog, records: LogLine[]): void {
    const serializedRecords = records.map((record) => `${JSON.stringify(record)}\n`);
    const checkpoints: Buffer[] = [];
    let recordIndex = state.totalRecords;
    for (const serializedRecord of serializedRecords) {
      if (recordIndex % CHECKPOINT_INTERVAL === 0) {
        const checkpoint = Buffer.allocUnsafe(CHECKPOINT_BYTES);
        checkpoint.writeBigUInt64LE(BigInt(state.bytesQueued));
        checkpoints.push(checkpoint);
      }
      state.bytesQueued += Buffer.byteLength(serializedRecord);
      recordIndex += 1;
    }
    const serialized = serializedRecords.join("");
    const checkpointData = checkpoints.length > 0 ? Buffer.concat(checkpoints) : null;
    const partials = JSON.stringify({ stdout: state.stdout, stderr: state.stderr });
    state.totalRecords += records.length;
    state.writeChain = state.writeChain.then(async () => {
      if (serialized) await writeFile(path, serialized, { flag: "a" });
      if (checkpointData) await writeFile(indexPath(path), checkpointData, { flag: "a" });
      await writeFile(partialPath(path), partials);
    });
  }

  private requireLog(path: string): PendingLog {
    const state = this.pending.get(path);
    if (!state) throw new Error("unknown log path");
    return state;
  }

  private assertOpen(): void {
    if (this.cleaned) throw new Error("log store has been cleaned up");
  }
}

function consumeText(
  stream: LogStream,
  text: string,
  maxLineCharacters: number,
): { records: LogLine[]; partial: string } {
  const records: LogLine[] = [];
  let remaining = text;
  while (true) {
    const newline = remaining.indexOf("\n");
    if (newline < 0) {
      while (remaining.length > maxLineCharacters) {
        const cut = safeCut(remaining, maxLineCharacters);
        records.push({ stream, text: remaining.slice(0, cut) });
        remaining = remaining.slice(cut);
      }
      return { records, partial: remaining };
    }

    let line = remaining.slice(0, newline);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    remaining = remaining.slice(newline + 1);
    if (line.length === 0) {
      records.push({ stream, text: "" });
      continue;
    }
    while (line.length > maxLineCharacters) {
      const cut = safeCut(line, maxLineCharacters);
      records.push({ stream, text: line.slice(0, cut) });
      line = line.slice(cut);
    }
    records.push({ stream, text: line });
  }
}

function safeCut(text: string, maximum: number): number {
  if (maximum >= text.length) return text.length;
  const previous = text.charCodeAt(maximum - 1);
  const next = text.charCodeAt(maximum);
  const splitsSurrogate = previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
  return splitsSurrogate ? maximum - 1 : maximum;
}

async function readCheckpoint(path: string, checkpointIndex: number): Promise<number> {
  const file = await open(indexPath(path), "r");
  try {
    const checkpoint = Buffer.alloc(CHECKPOINT_BYTES);
    const { bytesRead } = await file.read(
      checkpoint,
      0,
      CHECKPOINT_BYTES,
      checkpointIndex * CHECKPOINT_BYTES,
    );
    if (bytesRead !== CHECKPOINT_BYTES) throw new Error("log checkpoint is missing or truncated");
    const offset = checkpoint.readBigUInt64LE();
    if (offset > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("log checkpoint exceeds safe file offsets");
    return Number(offset);
  } finally {
    await file.close();
  }
}

function indexPath(path: string): string {
  return `${path}.idx`;
}

function partialPath(path: string): string {
  return `${path}.partial.json`;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}
