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

  it("falls back per field and reports malformed values", () => {
    const result = parseBackgroundBashConfig({
      shortcut: " ",
      widgetIcon: 42,
      completionNotifications: "yes",
      showLatestCompleted: null,
    });

    expect(result.config).toEqual(DEFAULT_BACKGROUND_BASH_CONFIG);
    expect(result.diagnostics).toEqual([
      "shortcut must be a non-empty string",
      "widgetIcon must be a string",
      "completionNotifications must be a boolean",
      "showLatestCompleted must be a boolean",
    ]);
  });
});
