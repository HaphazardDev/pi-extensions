import { describe, expect, it, vi } from "vitest";
import askUserQuestion from "../src/index.js";
import { createMockContext, createMockPi, createMockUi } from "../../test-utils/pi.js";

function registerTool() {
  const pi = createMockPi();
  askUserQuestion(pi as any);
  return pi.tools[0];
}

describe("pi-ask-user-question", () => {
  it("registers the ask_user_question tool", () => {
    const tool = registerTool();

    expect(tool.name).toBe("ask_user_question");
    expect(tool.label).toBe("Ask User Question");
    expect(tool.execute).toEqual(expect.any(Function));
  });

  it("returns an error when UI is unavailable", async () => {
    const tool = registerTool();
    const result = await tool.execute("id", { question: "Continue?" }, undefined, undefined, createMockContext({ hasUI: false }));

    expect(result.content[0].text).toContain("UI is not available");
    expect(result.details).toMatchObject({ question: "Continue?", answer: null, cancelled: true, mode: "input" });
  });

  it.each([
    [true, "User confirmed: yes", "yes"],
    [false, "User answered: no", "no"],
  ])("handles confirm mode resolving %s", async (confirmed, text, answer) => {
    const tool = registerTool();
    const ui = createMockUi({ confirm: vi.fn().mockResolvedValue(confirmed) });

    const result = await tool.execute("id", { question: "Continue?", confirmOnly: true }, undefined, undefined, createMockContext({ ui }));

    expect(ui.confirm).toHaveBeenCalledWith("Continue?", "Confirm to continue");
    expect(result.content[0].text).toBe(text);
    expect(result.details).toMatchObject({ answer, cancelled: false, mode: "confirm" });
  });

  it("trims free-form input answers", async () => {
    const tool = registerTool();
    const ui = createMockUi({ input: vi.fn().mockResolvedValue("  hello  ") });

    const result = await tool.execute("id", { question: "What?" }, undefined, undefined, createMockContext({ ui }));

    expect(result.content[0].text).toBe("User answered: hello");
    expect(result.details).toMatchObject({ answer: "hello", cancelled: false, mode: "input" });
  });

  it("treats whitespace input as cancelled", async () => {
    const tool = registerTool();
    const ui = createMockUi({ input: vi.fn().mockResolvedValue("   ") });

    const result = await tool.execute("id", { question: "What?" }, undefined, undefined, createMockContext({ ui }));

    expect(result.details).toMatchObject({ answer: null, cancelled: true, mode: "input" });
  });

  it("uses editor mode for multiline or initial values", async () => {
    const tool = registerTool();
    const ui = createMockUi({ editor: vi.fn().mockResolvedValue("  edited  ") });

    const result = await tool.execute("id", { question: "Edit", multiline: true, initialValue: "draft" }, undefined, undefined, createMockContext({ ui }));

    expect(ui.editor).toHaveBeenCalledWith("Edit", "draft");
    expect(result.details).toMatchObject({ answer: "edited", cancelled: false, mode: "editor" });
  });

  it("handles option selection", async () => {
    const tool = registerTool();
    const ui = createMockUi({ custom: vi.fn().mockImplementation((_component) => Promise.resolve("B")) });

    const result = await tool.execute("id", { question: "Pick", options: ["A", "B"] }, undefined, undefined, createMockContext({ ui }));

    expect(result.content[0].text).toBe("User selected: B");
    expect(result.details).toMatchObject({ answer: "B", cancelled: false, mode: "select", options: ["A", "B"] });
  });

  it("keeps single-choice option selection distinct from multi-select", async () => {
    const tool = registerTool();
    const ui = createMockUi({ custom: vi.fn().mockResolvedValue("A") });

    const result = await tool.execute("id", { question: "Pick one", options: ["A", "B"] }, undefined, undefined, createMockContext({ ui }));

    expect(result.content[0].text).toBe("User selected: A");
    expect(result.details).toMatchObject({ answer: "A", cancelled: false, mode: "select" });
    expect(result.details.answers).toBeUndefined();
  });

  it("handles multi-select option answers", async () => {
    const tool = registerTool();
    const ui = createMockUi({ custom: vi.fn().mockResolvedValue(["A", "C"]) });

    const result = await tool.execute(
      "id",
      { question: "Select all valid answers", options: ["A", "B", "C"], multiSelect: true },
      undefined,
      undefined,
      createMockContext({ ui }),
    );

    expect(result.content[0].text).toBe("User selected: A, C");
    expect(result.details).toMatchObject({
      answer: ["A", "C"],
      cancelled: false,
      mode: "multi-select",
      options: ["A", "B", "C"],
    });
    expect(result.details.answers).toBeUndefined();
  });

  it("handles cancelled multi-select option answers", async () => {
    const tool = registerTool();
    const ui = createMockUi({ custom: vi.fn().mockResolvedValue(null) });

    const result = await tool.execute(
      "id",
      { question: "Select all valid answers", options: ["A", "B"], multiSelect: true },
      undefined,
      undefined,
      createMockContext({ ui }),
    );

    expect(result.content[0].text).toBe("User cancelled the question.");
    expect(result.details).toMatchObject({ answer: null, cancelled: true, mode: "multi-select" });
    expect(result.details.answers).toBeUndefined();
  });

  it("toggles multiple options in the multi-select UI before submitting", async () => {
    const tool = registerTool();
    const ui = createMockUi({
      custom: vi.fn().mockImplementation((component) =>
        new Promise((resolve) => {
          const widget = component(
            { requestRender: vi.fn() },
            { fg: (_color: string, text: string) => text },
            {},
            resolve,
          );

          widget.handleInput(" ");
          widget.handleInput("\x1b[B");
          widget.handleInput("\x1b[B");
          widget.handleInput(" ");
          widget.handleInput("\r");
        }),
      ),
    });

    const result = await tool.execute(
      "id",
      { question: "Select all valid answers", options: ["A", "B", "C"], multiSelect: true },
      undefined,
      undefined,
      createMockContext({ ui }),
    );

    expect(result.details).toMatchObject({ answer: ["A", "C"], mode: "multi-select" });
    expect(result.details.answers).toBeUndefined();
  });

  it("handles cancelled option selection", async () => {
    const tool = registerTool();
    const ui = createMockUi({ custom: vi.fn().mockResolvedValue(null) });

    const result = await tool.execute("id", { question: "Pick", options: ["A"] }, undefined, undefined, createMockContext({ ui }));

    expect(result.details).toMatchObject({ answer: null, cancelled: true, mode: "select" });
  });

  it("prompts for a custom answer when the custom option is selected", async () => {
    const tool = registerTool();
    const ui = createMockUi({
      custom: vi.fn().mockResolvedValue("Type your own answer…"),
      input: vi.fn().mockResolvedValue("custom"),
    });

    const result = await tool.execute("id", { question: "Pick", options: ["A"] }, undefined, undefined, createMockContext({ ui }));

    expect(ui.input).toHaveBeenCalledWith("Pick", undefined);
    expect(result.details).toMatchObject({ answer: "custom", cancelled: false, mode: "input" });
  });

  it("does not offer a custom answer when allowCustomAnswer is false", async () => {
    const tool = registerTool();
    const ui = createMockUi({ custom: vi.fn().mockResolvedValue("A") });

    await tool.execute("id", { question: "Pick", options: ["A"], allowCustomAnswer: false }, undefined, undefined, createMockContext({ ui }));

    expect(ui.input).not.toHaveBeenCalled();
  });
});
