import { describe, expect, it } from "vitest";
import piVimQuit from "../src/index.js";
import { createMockContext, createMockPi } from "../../test-utils/pi.js";

describe("pi-vim-quit", () => {
  it("registers an input handler", () => {
    const pi = createMockPi();

    piVimQuit(pi as any);

    expect(pi.on).toHaveBeenCalledWith("input", expect.any(Function));
    expect(pi.handlers.get("input")).toHaveLength(1);
  });

  it.each([":q", ":qa", ":wq"])("handles %s by notifying and shutting down", async (text) => {
    const pi = createMockPi();
    const ctx = createMockContext();
    piVimQuit(pi as any);

    const handler = pi.handlers.get("input")![0]!;
    const result = await handler({ text, source: "user" }, ctx);

    expect(result).toEqual({ action: "handled" });
    expect(ctx.ui.notify).toHaveBeenCalledWith("Quitting pi…", "info");
    expect(ctx.shutdown).toHaveBeenCalledOnce();
  });

  it("continues for non-quit input", async () => {
    const pi = createMockPi();
    const ctx = createMockContext();
    piVimQuit(pi as any);

    const handler = pi.handlers.get("input")![0]!;
    const result = await handler({ text: "hello", source: "user" }, ctx);

    expect(result).toEqual({ action: "continue" });
    expect(ctx.ui.notify).not.toHaveBeenCalled();
    expect(ctx.shutdown).not.toHaveBeenCalled();
  });

  it("continues for extension input without shutting down", async () => {
    const pi = createMockPi();
    const ctx = createMockContext();
    piVimQuit(pi as any);

    const handler = pi.handlers.get("input")![0]!;
    const result = await handler({ text: ":q", source: "extension" }, ctx);

    expect(result).toEqual({ action: "continue" });
    expect(ctx.ui.notify).not.toHaveBeenCalled();
    expect(ctx.shutdown).not.toHaveBeenCalled();
  });
});
