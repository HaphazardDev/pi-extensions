import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface BackgroundBashConfig {
  shortcut: string;
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
    if (typeof value.shortcut === "string" && value.shortcut.trim().length > 0) config.shortcut = value.shortcut.trim();
    else diagnostics.push("shortcut must be a non-empty string");
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
