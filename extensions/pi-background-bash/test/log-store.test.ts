import { access, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LogStore } from "../src/log-store.js";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("LogStore", () => {
  it("creates an isolated per-manager temporary directory and log file", async () => {
    const first = new LogStore();
    const second = new LogStore();
    try {
      expect(first.directory).not.toBe(second.directory);
      expect(first.directory.startsWith(tmpdir())).toBe(true);
      const path = await first.createLog("bg-a1");
      expect(path).toBe(join(first.directory, "bg-a1.jsonl"));
      expect(await exists(path)).toBe(true);
    } finally {
      await first.cleanup();
      await second.cleanup();
    }
  });

  it("preserves stdout and stderr lines, including chunked partial lines", async () => {
    const store = new LogStore();
    try {
      const path = await store.createLog("bg-a2");
      await store.append(path, "stdout", "out one\npartial");
      await store.append(path, "stderr", "err one\n");
      await store.append(path, "stdout", " out two");
      await store.closeLog(path);

      const page = await store.read(path, { offset: 0, limit: 10 });
      expect(page.lines).toEqual([
        { stream: "stdout", text: "out one" },
        { stream: "stderr", text: "err one" },
        { stream: "stdout", text: "partial out two" },
      ]);
      expect(page).toMatchObject({ totalLines: 3, hasMore: false, nextOffset: null });
    } finally {
      await store.cleanup();
    }
  });

  it("bounds long lines and page character volume", async () => {
    const store = new LogStore({ maxLineCharacters: 8, maxPageCharacters: 12 });
    try {
      const path = await store.createLog("bg-bounded");
      await store.append(path, "stdout", "abcdefghijklmnopqrst\n");

      const first = await store.read(path, { limit: 100 });
      expect(first.totalLines).toBe(3);
      expect(first.lines).toEqual([{ stream: "stdout", text: "abcdefgh" }]);
      expect(first.hasMore).toBe(true);
      expect(first.nextOffset).toBe(1);

      const rest = await store.read(path, { offset: 1, limit: 100 });
      expect(rest.lines.every((line) => line.text.length <= 8)).toBe(true);
      expect(rest.lines.map((line) => line.text)).toEqual(["ijklmnop", "qrst"]);
      expect(rest.hasMore).toBe(false);
    } finally {
      await store.cleanup();
    }
  });

  it("persists and exposes an unterminated line while the job is still running", async () => {
    const store = new LogStore();
    try {
      const path = await store.createLog("bg-partial");
      await store.append(path, "stdout", "still running");

      expect((await store.read(path)).lines).toEqual([{ stream: "stdout", text: "still running" }]);
      expect(await exists(`${path}.partial.json`)).toBe(true);
    } finally {
      await store.cleanup();
    }
  });

  it("preserves UTF-8 characters split across output chunks", async () => {
    const store = new LogStore();
    try {
      const path = await store.createLog("bg-utf8");
      const bytes = Buffer.from("snowman ☃\n");
      const split = bytes.indexOf(0xe2) + 1;
      await store.append(path, "stdout", bytes.subarray(0, split));
      await store.append(path, "stdout", bytes.subarray(split));
      await store.append(path, "stdout", "second ✓\n");
      expect((await store.read(path)).lines).toEqual([
        { stream: "stdout", text: "snowman ☃" },
        { stream: "stdout", text: "second ✓" },
      ]);
      expect((await store.read(path, { offset: 1 })).lines).toEqual([
        { stream: "stdout", text: "second ✓" },
      ]);
    } finally {
      await store.cleanup();
    }
  });

  it("paginates by bounded line offsets", async () => {
    const store = new LogStore({ maxPageLimit: 2 });
    try {
      const path = await store.createLog("bg-a3");
      await store.append(path, "stdout", "zero\none\ntwo\nthree\n");

      const page = await store.read(path, { offset: 1, limit: 99 });
      expect(page.limit).toBe(2);
      expect(page.lines.map((line) => line.text)).toEqual(["one", "two"]);
      expect(page).toMatchObject({ offset: 1, totalLines: 4, hasMore: true, nextOffset: 3 });

      const last = await store.read(path, { offset: 3, limit: 2 });
      expect(last.lines.map((line) => line.text)).toEqual(["three"]);
      expect(last).toMatchObject({ totalLines: 4, hasMore: false, nextOffset: null });
    } finally {
      await store.cleanup();
    }
  });

  it("keeps sparse pagination checkpoints on disk instead of per-line heap offsets", async () => {
    const store = new LogStore();
    try {
      const path = await store.createLog("bg-indexed");
      const output = Array.from({ length: 2_050 }, (_, index) => `line-${index}-☃`).join("\n") + "\n";
      await store.append(path, "stdout", output);

      expect((await stat(`${path}.idx`)).size).toBe(24);
      expect((await store.read(path, { offset: 2_049, limit: 1 })).lines).toEqual([
        { stream: "stdout", text: "line-2049-☃" },
      ]);
    } finally {
      await store.cleanup();
    }
  });

  it("returns a consistent snapshot when another write queues during a read", async () => {
    const store = new LogStore();
    try {
      const path = await store.createLog("bg-concurrent-read");
      const firstWrite = store.append(path, "stdout", "one\n");
      const reading = store.read(path);
      const secondWrite = store.append(path, "stdout", "two\n");

      await firstWrite;
      const page = await reading;
      await secondWrite;
      expect(page.totalLines).toBe(1);
      expect(page.lines).toEqual([{ stream: "stdout", text: "one" }]);
    } finally {
      await store.cleanup();
    }
  });

  it("rejects invalid offsets and limits", async () => {
    const store = new LogStore();
    try {
      const path = await store.createLog("bg-a4");
      await expect(store.read(path, { offset: -1, limit: 1 })).rejects.toThrow("offset");
      await expect(store.read(path, { offset: 0, limit: 0 })).rejects.toThrow("limit");
    } finally {
      await store.cleanup();
    }
  });

  it("removes its directory even when a queued log write failed", async () => {
    const store = new LogStore();
    const path = await store.createLog("bg-write-failure");
    await rm(store.directory, { recursive: true, force: true });

    await expect(store.append(path, "stdout", "lost\n")).rejects.toThrow();
    await expect(store.cleanup()).rejects.toThrow();
    expect(await exists(store.directory)).toBe(false);
  });

  it("removes all manager logs during cleanup", async () => {
    const store = new LogStore();
    const directory = store.directory;
    await store.createLog("bg-a5");
    await store.cleanup();
    expect(await exists(directory)).toBe(false);
    await store.cleanup();
  });

  it("removes one closed log without disturbing other jobs", async () => {
    const store = new LogStore();
    try {
      const removed = await store.createLog("bg-remove");
      const retained = await store.createLog("bg-retain");
      await store.append(removed, "stdout", "remove me\n");
      await store.append(retained, "stdout", "keep me\n");
      await store.closeLog(removed);
      await store.closeLog(retained);

      await store.remove(removed);

      expect(await exists(removed)).toBe(false);
      expect(await exists(`${removed}.idx`)).toBe(false);
      expect(await exists(`${removed}.partial.json`)).toBe(false);
      await expect(store.read(removed)).rejects.toThrow("unknown log path");
      expect((await store.read(retained)).lines).toEqual([{ stream: "stdout", text: "keep me" }]);
    } finally {
      await store.cleanup();
    }
  });

  it("can remove a closed log after its queued write failed", async () => {
    const store = new LogStore();
    const path = await store.createLog("bg-failed-remove");
    await rm(store.directory, { recursive: true, force: true });
    await expect(store.append(path, "stdout", "lost\n")).rejects.toThrow();
    await expect(store.closeLog(path)).rejects.toThrow();

    await expect(store.remove(path)).resolves.toBeUndefined();
    await expect(store.read(path)).rejects.toThrow("unknown log path");
    await store.cleanup();
  });

  it("keeps a log registered so a failed file deletion can be retried", async () => {
    const store = new LogStore();
    const path = await store.createLog("bg-retry-remove");
    await store.closeLog(path);
    await rm(path);
    await mkdir(path);

    await expect(store.remove(path)).rejects.toThrow();
    await rm(path, { recursive: true });
    await expect(store.remove(path)).resolves.toBeUndefined();
    await expect(store.read(path)).rejects.toThrow("unknown log path");
    await store.cleanup();
  });
});
