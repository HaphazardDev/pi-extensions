import { beforeEach, describe, expect, it, vi } from "vitest";
import clipboard from "clipboardy";
import piCopyCodeBlock, {
  extractCodeBlocks,
  formatAllBlocksForClipboard,
  formatSingleBlockForClipboard,
  parseCopyRequest,
  resolveRequestedBlock,
} from "../src/index.js";
import { createMockContext, createMockPi, createMockUi } from "../../test-utils/pi.js";

vi.mock("clipboardy", () => ({ default: { write: vi.fn() } }));

function assistant(text: string, stopReason = "stop") {
  return { type: "message", message: { role: "assistant", stopReason, content: [{ type: "text", text }] } };
}

describe("pi-copy-code-block pure helpers", () => {
  it("extracts fenced code blocks with languages and normalized code", () => {
    const blocks = extractCodeBlocks("before\n```ts\r\nconst a = 1;\r\n```\nmid\n```\nplain\n```\n");

    expect(blocks).toEqual([
      { index: 1, language: "text", code: "plain", preview: "plain" },
      { index: 2, language: "ts", code: "const a = 1;", preview: "const a = 1;" },
    ]);
  });

  it("returns no blocks when no fences exist", () => {
    expect(extractCodeBlocks("no code here")).toEqual([]);
  });

  it.each([
    [undefined, { kind: "single", fenced: false }],
    ["2", { kind: "single", fenced: false, selector: "2" }],
    ["first", { kind: "single", fenced: false, selector: "first" }],
    ["last", { kind: "single", fenced: false, selector: "last" }],
    ["all", { kind: "all", fenced: false }],
    ["fenced 2", { kind: "single", fenced: true, selector: "2" }],
    ["fenced all", { kind: "all", fenced: true }],
  ])("parses copy request %s", (input, request) => {
    expect(parseCopyRequest(input as string | undefined).request).toEqual(request);
  });

  it("rejects copy requests with too many arguments", () => {
    expect(parseCopyRequest("one two").error).toContain("Too many arguments");
  });

  it("resolves requested blocks", () => {
    const blocks = extractCodeBlocks("```a\none\n```\n```b\ntwo\n```");

    expect(resolveRequestedBlock(undefined, [blocks[0]!])).toEqual({ block: blocks[0] });
    expect(resolveRequestedBlock(undefined, blocks)).toEqual({ requiresPicker: true });
    expect(resolveRequestedBlock("1", blocks)).toEqual({ block: blocks[0] });
    expect(resolveRequestedBlock("3", blocks).error).toContain("does not exist");
    expect(resolveRequestedBlock("first", blocks)).toEqual({ block: blocks[0] });
    expect(resolveRequestedBlock("f", blocks)).toEqual({ block: blocks[0] });
    expect(resolveRequestedBlock("last", blocks)).toEqual({ block: blocks[1] });
    expect(resolveRequestedBlock("l", blocks)).toEqual({ block: blocks[1] });
  });

  it("formats clipboard content", () => {
    const tsBlock = { index: 1, language: "ts", code: "const a = 1;", preview: "const a = 1;" };
    const textBlock = { index: 2, language: "text", code: "plain", preview: "plain" };

    expect(formatSingleBlockForClipboard(tsBlock, false)).toBe("const a = 1;");
    expect(formatSingleBlockForClipboard(tsBlock, true)).toBe("```ts\nconst a = 1;\n```");
    expect(formatSingleBlockForClipboard(textBlock, true)).toBe("```\nplain\n```");
    expect(formatAllBlocksForClipboard([tsBlock, textBlock], false)).toBe("const a = 1;\n\nplain");
  });
});

describe("pi-copy-code-block extension", () => {
  beforeEach(() => {
    vi.mocked(clipboard.write).mockReset();
  });

  it("registers command, shortcut, and status refresh handlers", () => {
    const pi = createMockPi();

    piCopyCodeBlock(pi as any);

    expect(pi.commands.has("copy-code")).toBe(true);
    expect(pi.shortcuts.size).toBe(1);
    expect(pi.handlers.get("session_start")).toHaveLength(1);
    expect(pi.handlers.get("turn_end")).toHaveLength(1);
    expect(pi.handlers.get("session_tree")).toHaveLength(1);
  });

  it("copies the only code block from the latest completed assistant message", async () => {
    const pi = createMockPi();
    const ctx = createMockContext();
    ctx.sessionManager.getBranch.mockReturnValue([assistant("```ts\nconst a = 1;\n```")]);
    piCopyCodeBlock(pi as any);

    await pi.commands.get("copy-code").handler("", ctx);

    expect(clipboard.write).toHaveBeenCalledWith("const a = 1;");
    expect(ctx.ui.notify).toHaveBeenCalledWith("Copied code block.", "info");
  });

  it("copies all blocks as fenced content", async () => {
    const pi = createMockPi();
    const ctx = createMockContext();
    ctx.sessionManager.getBranch.mockReturnValue([assistant("```ts\none\n```\n```\ntwo\n```")]);
    piCopyCodeBlock(pi as any);

    await pi.commands.get("copy-code").handler("fenced all", ctx);

    expect(clipboard.write).toHaveBeenCalledWith("```\ntwo\n```\n\n```ts\none\n```");
    expect(ctx.ui.notify).toHaveBeenCalledWith("Copied all 2 fenced code blocks.", "info");
  });

  it("warns when multiple blocks require a selector without UI", async () => {
    const pi = createMockPi();
    const ctx = createMockContext({ hasUI: false });
    ctx.sessionManager.getBranch.mockReturnValue([assistant("```\none\n```\n```\ntwo\n```")]);
    piCopyCodeBlock(pi as any);

    await pi.commands.get("copy-code").handler("", ctx);

    expect(clipboard.write).not.toHaveBeenCalled();
  });

  it("uses the picker when multiple blocks exist", async () => {
    const pi = createMockPi();
    const ui = createMockUi({ custom: vi.fn().mockResolvedValue({ index: 2, language: "text", code: "one", preview: "one" }) });
    const ctx = createMockContext({ ui });
    ctx.sessionManager.getBranch.mockReturnValue([assistant("```\none\n```\n```\ntwo\n```")]);
    piCopyCodeBlock(pi as any);

    await pi.commands.get("copy-code").handler("", ctx);

    expect(ui.custom).toHaveBeenCalled();
    expect(clipboard.write).toHaveBeenCalledWith("one");
  });

  it("ignores incomplete assistant messages and warns for missing code", async () => {
    const pi = createMockPi();
    const ctx = createMockContext();
    ctx.sessionManager.getBranch.mockReturnValue([assistant("```\nnope\n```", "length")]);
    piCopyCodeBlock(pi as any);

    await pi.commands.get("copy-code").handler("", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith("No completed assistant message found.", "warning");
  });

  it("warns when completed assistant messages contain no code or selector is invalid", async () => {
    const pi = createMockPi();
    const ctx = createMockContext();
    ctx.sessionManager.getBranch.mockReturnValue([assistant("no code")]);
    piCopyCodeBlock(pi as any);

    await pi.commands.get("copy-code").handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("No code blocks found in the last 1 assistant message.", "warning");

    ctx.ui.notify.mockClear();
    ctx.sessionManager.getBranch.mockReturnValue([assistant("```\none\n```")]);
    await pi.commands.get("copy-code").handler("2", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Code block 2 does not exist. Found 1 block(s).", "warning");
  });

  it("updates and clears the status hint", async () => {
    const pi = createMockPi();
    const ctx = createMockContext();
    piCopyCodeBlock(pi as any);

    ctx.sessionManager.getBranch.mockReturnValue([assistant("```\none\n```")]);
    await pi.handlers.get("turn_end")![0]!({}, ctx);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("copy-code", expect.stringContaining("1 code block"));

    ctx.ui.setStatus.mockClear();
    ctx.sessionManager.getBranch.mockReturnValue([assistant("no code")]);
    await pi.handlers.get("turn_end")![0]!({}, ctx);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("copy-code", undefined);
  });
});
