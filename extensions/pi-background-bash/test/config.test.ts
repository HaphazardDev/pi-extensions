import { describe, expect, it } from "vitest";
import {
  DEFAULT_BACKGROUND_BASH_CONFIG,
  parseBackgroundBashConfig,
} from "../src/config.js";

describe("background Bash configuration", () => {
  it("uses safe defaults when no configuration is provided", () => {
    expect(parseBackgroundBashConfig(undefined)).toEqual({
      config: DEFAULT_BACKGROUND_BASH_CONFIG,
      diagnostics: [],
    });
  });

  it("accepts supported UI preferences", () => {
    expect(parseBackgroundBashConfig({
      shortcut: "ctrl+shift+b",
      widgetIcon: "&",
      completionNotifications: false,
      showLatestCompleted: false,
    })).toEqual({
      config: {
        shortcut: "ctrl+shift+b",
        widgetIcon: "&",
        completionNotifications: false,
        showLatestCompleted: false,
      },
      diagnostics: [],
    });
  });

  it.each(["escape", "f1", "shift+clear", "ctrl+clear"] as const)("accepts the dispatchable Pi shortcut %s", (shortcut) => {
    expect(parseBackgroundBashConfig({ shortcut })).toEqual({
      config: { ...DEFAULT_BACKGROUND_BASH_CONFIG, shortcut },
      diagnostics: [],
    });
  });

  it.each([
    "+",
    "ctrl++",
    "ctrl+shift++",
    "ctrl+escape",
    "shift+esc",
    "shift+f1",
    "ctrl+f12",
    "alt+clear",
    "super+clear",
    "ctrl+shift+clear",
  ] as const)("rejects the Pi shortcut %s because matchesKey cannot dispatch it", (shortcut) => {
    const result = parseBackgroundBashConfig({ shortcut });

    expect(result.config.shortcut).toBe(DEFAULT_BACKGROUND_BASH_CONFIG.shortcut);
    expect(result.diagnostics).toEqual(["shortcut must be a usable Pi key identifier"]);
  });

  it("falls back per field and reports malformed values", () => {
    const result = parseBackgroundBashConfig({
      shortcut: " ",
      widgetIcon: 42,
      completionNotifications: "yes",
      showLatestCompleted: null,
    });

    expect(result.config).toEqual(DEFAULT_BACKGROUND_BASH_CONFIG);
    expect(result.diagnostics).toEqual([
      "shortcut must be a usable Pi key identifier",
      "widgetIcon must be a string",
      "completionNotifications must be a boolean",
      "showLatestCompleted must be a boolean",
    ]);
  });
});
