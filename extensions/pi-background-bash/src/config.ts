import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";

export interface BackgroundBashConfig {
  shortcut: KeyId;
  widgetIcon: string;
  completionNotifications: boolean;
  showLatestCompleted: boolean;
}

export interface BackgroundBashConfigResult {
  config: BackgroundBashConfig;
  diagnostics: string[];
}

export const DEFAULT_BACKGROUND_BASH_CONFIG: Readonly<BackgroundBashConfig> = Object.freeze({
  shortcut: "ctrl+alt+k",
  widgetIcon: "",
  completionNotifications: true,
  showLatestCompleted: true,
});

export function parseBackgroundBashConfig(value: unknown): BackgroundBashConfigResult {
  const config: BackgroundBashConfig = { ...DEFAULT_BACKGROUND_BASH_CONFIG };
  const diagnostics: string[] = [];
  if (value === undefined) return { config, diagnostics };
  if (!isRecord(value)) return { config, diagnostics: ["configuration must be a JSON object"] };

  if ("shortcut" in value) {
    const shortcut = typeof value.shortcut === "string" ? value.shortcut.trim() : "";
    if (isKeyId(shortcut)) config.shortcut = shortcut;
    else diagnostics.push("shortcut must be a usable Pi key identifier");
  }
  if ("widgetIcon" in value) {
    if (typeof value.widgetIcon === "string") config.widgetIcon = value.widgetIcon;
    else diagnostics.push("widgetIcon must be a string");
  }
  if ("completionNotifications" in value) {
    if (typeof value.completionNotifications === "boolean") config.completionNotifications = value.completionNotifications;
    else diagnostics.push("completionNotifications must be a boolean");
  }
  if ("showLatestCompleted" in value) {
    if (typeof value.showLatestCompleted === "boolean") config.showLatestCompleted = value.showLatestCompleted;
    else diagnostics.push("showLatestCompleted must be a boolean");
  }
  return { config, diagnostics };
}

export function loadBackgroundBashConfig(
  path = join(getAgentDir(), "extensions", "pi-background-bash", "config.json"),
): BackgroundBashConfigResult {
  let serialized: string;
  try {
    serialized = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return parseBackgroundBashConfig(undefined);
    return {
      config: { ...DEFAULT_BACKGROUND_BASH_CONFIG },
      diagnostics: [`cannot read ${path}: ${errorMessage(error)}`],
    };
  }
  try {
    return parseBackgroundBashConfig(JSON.parse(serialized));
  } catch (error) {
    return {
      config: { ...DEFAULT_BACKGROUND_BASH_CONFIG },
      diagnostics: [`cannot parse ${path}: ${errorMessage(error)}`],
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SPECIAL_KEYS = new Set([
  "escape", "esc", "enter", "return", "tab", "space", "backspace", "delete", "insert", "clear",
  "home", "end", "pageUp", "pageDown", "up", "down", "left", "right",
  "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
]);
const SYMBOL_KEYS = new Set(Array.from("`-=[]\\;',./!@#$%^&*()_+|~{}:<>?"));
const MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);

function isKeyId(value: string): value is KeyId {
  const parts = value.split("+");
  const base = parts.pop() ?? "";
  const modifiers = parts;
  const validBase = /^[a-z0-9]$/.test(base) || SPECIAL_KEYS.has(base) || SYMBOL_KEYS.has(base);
  const hasDispatchableModifiers = !(["escape", "esc"].includes(base) || /^f(?:[1-9]|1[0-2])$/.test(base))
    ? true
    : modifiers.length === 0;
  const hasDispatchableClearModifiers = base !== "clear"
    || modifiers.length === 0
    || (modifiers.length === 1 && (modifiers[0] === "ctrl" || modifiers[0] === "shift"));
  return validBase
    && hasDispatchableModifiers
    && hasDispatchableClearModifiers
    && modifiers.length <= MODIFIERS.size
    && modifiers.every((modifier) => MODIFIERS.has(modifier))
    && new Set(modifiers).size === modifiers.length;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
