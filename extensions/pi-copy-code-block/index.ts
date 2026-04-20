import { setText } from "@mariozechner/clipboard";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";

const extensionConfig = {
  showStatusHint: true,
  statusIcon: "⎘",
  shortcut: Key.ctrlAlt("c"),
  previewWidth: 60,
  copyAllSeparator: "\n\n",
  maxAssistantMessagesToScan: 5,
} as const;

const shortcutHint = formatShortcutHint(extensionConfig.shortcut);

interface CodeBlock {
  index: number;
  language: string;
  code: string;
  preview: string;
}

interface CopyContext {
  hasUI: boolean;
  sessionManager: ExtensionContext["sessionManager"];
  ui: ExtensionContext["ui"];
}

interface ParsedCopyRequest {
  kind: "single" | "all";
  fenced: boolean;
  selector?: string;
}

function formatShortcutHint(shortcut: string): string {
  return shortcut
    .split("+")
    .map((part) => (part.length === 1 ? part.toUpperCase() : `${part[0]!.toUpperCase()}${part.slice(1)}`))
    .join("+");
}

function getAssistantText(message: AssistantMessage): string {
  return message.content
    .filter((content): content is { type: "text"; text: string } => content.type === "text")
    .map((content) => content.text)
    .join("\n")
    .trim();
}

function getCodeBlocksFromRecentAssistantMessages(ctx: CopyContext): {
  blocks: CodeBlock[] | null;
  scannedAssistantMessages: number;
} {
  const branch = ctx.sessionManager.getBranch();
  let scannedAssistantMessages = 0;

  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;

    const message = entry.message as AssistantMessage;
    if (message.stopReason !== "stop") continue;

    const text = getAssistantText(message);
    if (text.length === 0) continue;

    scannedAssistantMessages++;
    const blocks = extractCodeBlocks(text);
    if (blocks.length > 0) {
      return { blocks, scannedAssistantMessages };
    }

    if (scannedAssistantMessages >= extensionConfig.maxAssistantMessagesToScan) break;
  }

  return { blocks: null, scannedAssistantMessages };
}

function getPreview(code: string): string {
  const lines = code.replace(/\r\n/g, "\n").split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const firstVisibleLine = lines.find((line) => line.trim().length > 0) ?? lines[0] ?? "";
  if (firstVisibleLine.length === 0) return "(empty block)";

  const trimmedLine = firstVisibleLine.trimEnd();
  const maxWidth = extensionConfig.previewWidth;
  const linePreview = trimmedLine.length > maxWidth ? `${trimmedLine.slice(0, maxWidth - 1)}…` : trimmedLine;
  return lines.length > 1 ? `${linePreview} ⏎ …` : linePreview;
}

function extractCodeBlocks(text: string): CodeBlock[] {
  const extracted: Array<Pick<CodeBlock, "language" | "code">> = [];
  const fencePattern = /^```([^\n`]*)\r?\n([\s\S]*?)^```[ \t]*$/gm;

  let match: RegExpExecArray | null = fencePattern.exec(text);
  while (match) {
    const infoString = match[1]?.trim() ?? "";
    const language = infoString.split(/\s+/)[0] || "text";
    const code = match[2]?.replace(/\r\n/g, "\n") ?? "";

    extracted.push({ language, code });
    match = fencePattern.exec(text);
  }

  return extracted.reverse().map((block, index) => ({
    index: index + 1,
    language: block.language,
    code: block.code,
    preview: getPreview(block.code),
  }));
}

function parseCopyRequest(input?: string): { request?: ParsedCopyRequest; error?: string } {
  const tokens = (input ?? "")
    .trim()
    .split(/\s+/)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length > 0);

  if (tokens.length === 0) {
    return { request: { kind: "single", fenced: false } };
  }

  let fenced = false;
  const remaining = tokens.filter((token) => {
    if (token === "fenced") {
      fenced = true;
      return false;
    }
    return true;
  });

  if (remaining.length === 0) {
    return { request: { kind: "single", fenced } };
  }

  if (remaining.length > 1) {
    return {
      error: 'Too many arguments. Use /copy-code, /copy-code 2, /copy-code all, or /copy-code fenced 2.',
    };
  }

  const token = remaining[0]!;
  if (token === "all") {
    return { request: { kind: "all", fenced } };
  }

  return { request: { kind: "single", fenced, selector: token } };
}

function resolveRequestedBlock(selector: string | undefined, blocks: CodeBlock[]) {
  const normalized = selector?.trim().toLowerCase();

  if (!normalized) {
    return blocks.length === 1 ? { block: blocks[0] } : { requiresPicker: true };
  }

  if (/^\d+$/.test(normalized)) {
    const index = Number(normalized);
    if (index >= 1 && index <= blocks.length) {
      return { block: blocks[index - 1] };
    }
    return { error: `Code block ${index} does not exist. Found ${blocks.length} block(s).` };
  }

  if (normalized === "first" || normalized === "f") return { block: blocks[0] };
  if (normalized === "last" || normalized === "l") return { block: blocks[blocks.length - 1] };

  return { error: `Unknown code block selector "${selector}". Use a number, first/f, or last/l.` };
}

function formatSingleBlockForClipboard(block: CodeBlock, fenced: boolean): string {
  if (!fenced) return block.code;

  const body = block.code.endsWith("\n") ? block.code : `${block.code}\n`;
  const language = block.language === "text" ? "" : block.language;
  return `\`\`\`${language}\n${body}\`\`\``;
}

function formatAllBlocksForClipboard(blocks: CodeBlock[], fenced: boolean): string {
  return blocks.map((block) => formatSingleBlockForClipboard(block, fenced)).join(extensionConfig.copyAllSeparator);
}

async function selectCodeBlock(ctx: CopyContext, blocks: CodeBlock[]): Promise<CodeBlock | null> {
  return ctx.ui.custom<CodeBlock | null>((tui, theme, _kb, done) => {
    let optionIndex = 0;
    let cachedLines: string[] | undefined;

    function refresh() {
      cachedLines = undefined;
      tui.requestRender();
    }

    function choose(index: number) {
      if (index >= 0 && index < blocks.length) {
        done(blocks[index]);
      }
    }

    function handleInput(data: string) {
      if (matchesKey(data, Key.up)) {
        optionIndex = Math.max(0, optionIndex - 1);
        refresh();
        return;
      }

      if (matchesKey(data, Key.down)) {
        optionIndex = Math.min(blocks.length - 1, optionIndex + 1);
        refresh();
        return;
      }

      if (matchesKey(data, Key.enter)) {
        choose(optionIndex);
        return;
      }

      if (matchesKey(data, Key.escape)) {
        done(null);
        return;
      }

      if (/^[1-9]$/.test(data)) {
        choose(Number(data) - 1);
      }
    }

    function render(width: number): string[] {
      if (cachedLines) return cachedLines;

      const lines: string[] = [];
      const add = (text: string) => lines.push(truncateToWidth(text, width));

      add(theme.fg("accent", "─".repeat(width)));
      add(theme.fg("text", " Copy which code block?"));
      lines.push("");

      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        const selected = i === optionIndex;
        const prefix = selected ? theme.fg("accent", "> ") : "  ";
        const label = `${block.index}. ${block.preview}`;
        add(selected ? prefix + theme.fg("accent", label) : `  ${theme.fg("text", label)}`);
      }

      lines.push("");
      add(theme.fg("dim", " 1-9 choose • ↑↓ navigate • Enter select • Esc cancel"));
      add(theme.fg("accent", "─".repeat(width)));

      cachedLines = lines;
      return lines;
    }

    return {
      render,
      invalidate: () => {
        cachedLines = undefined;
      },
      handleInput,
    };
  });
}

function notify(ctx: CopyContext, message: string, level: "info" | "warning" | "error") {
  if (ctx.hasUI) ctx.ui.notify(message, level);
}

function updateCopyCodeStatus(ctx: CopyContext) {
  if (!ctx.hasUI) return;

  if (!extensionConfig.showStatusHint) {
    ctx.ui.setStatus("copy-code", undefined);
    return;
  }

  const { blocks } = getCodeBlocksFromRecentAssistantMessages(ctx);
  if (!blocks || blocks.length === 0) {
    ctx.ui.setStatus("copy-code", undefined);
    return;
  }

  const message =
    blocks.length === 1
      ? `${extensionConfig.statusIcon} 1 code block • ${shortcutHint} to copy`
      : `${extensionConfig.statusIcon} ${blocks.length} code blocks • /copy-code • ${shortcutHint}`;

  ctx.ui.setStatus("copy-code", ctx.ui.theme.fg("accent", message));
}

function getSingleBlockCopiedMessage(block: CodeBlock, blockCount: number, fenced: boolean): string {
  if (blockCount === 1) {
    return fenced ? "Copied fenced code block." : "Copied code block.";
  }

  return fenced ? `Copied fenced block ${block.index} of ${blockCount}.` : `Copied block ${block.index} of ${blockCount}.`;
}

function getAllBlocksCopiedMessage(blockCount: number, fenced: boolean): string {
  return fenced ? `Copied all ${blockCount} fenced code blocks.` : `Copied all ${blockCount} code blocks.`;
}

export default function piCopyCodeBlock(pi: ExtensionAPI) {
  async function copyTextToClipboard(ctx: CopyContext, text: string, message: string): Promise<void> {
    try {
      await setText(text);
      notify(ctx, message, "info");
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      notify(ctx, `Failed to copy code block: ${errorMessage}`, "error");
    }
  }

  async function copyCodeFromLatestAssistant(ctx: CopyContext, rawRequest?: string): Promise<void> {
    const parsed = parseCopyRequest(rawRequest);
    if (parsed.error) {
      notify(ctx, parsed.error, "warning");
      return;
    }

    const request = parsed.request!;

    const { blocks, scannedAssistantMessages } = getCodeBlocksFromRecentAssistantMessages(ctx);
    if (!blocks) {
      if (scannedAssistantMessages === 0) {
        notify(ctx, "No completed assistant message found.", "warning");
      } else {
        notify(
          ctx,
          `No code blocks found in the last ${scannedAssistantMessages} assistant message${scannedAssistantMessages === 1 ? "" : "s"}.`,
          "warning",
        );
      }
      return;
    }

    if (request.kind === "all") {
      const text = formatAllBlocksForClipboard(blocks, request.fenced);
      await copyTextToClipboard(ctx, text, getAllBlocksCopiedMessage(blocks.length, request.fenced));
      return;
    }

    const resolved = resolveRequestedBlock(request.selector, blocks);
    if (resolved.error) {
      notify(ctx, resolved.error, "warning");
      return;
    }

    let block = resolved.block ?? null;
    if (!block && resolved.requiresPicker) {
      if (!ctx.hasUI) {
        notify(ctx, "Multiple code blocks found. Use /copy-code <number>, /copy-code all, or /copy-code last.", "warning");
        return;
      }

      block = await selectCodeBlock(ctx, blocks);
      if (!block) {
        notify(ctx, "Copy cancelled.", "info");
        return;
      }
    }

    if (!block) return;

    const text = formatSingleBlockForClipboard(block, request.fenced);
    const message = getSingleBlockCopiedMessage(block, blocks.length, request.fenced);
    await copyTextToClipboard(ctx, text, message);
  }

  pi.on("session_start", async (_event, ctx) => {
    updateCopyCodeStatus(ctx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    updateCopyCodeStatus(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    updateCopyCodeStatus(ctx);
  });

  pi.registerCommand("copy-code", {
    description: "Copy code blocks from the latest assistant message",
    getArgumentCompletions: (prefix) => {
      const lower = prefix.toLowerCase().trimStart();
      const topLevel = ["all", "fenced", "first", "last"];
      const fencedTargets = ["all", "first", "last"];

      if (lower.startsWith("fenced ")) {
        const rest = lower.slice("fenced ".length);
        const matches = fencedTargets
          .filter((option) => option.startsWith(rest))
          .map((option) => ({ value: `fenced ${option}`, label: `fenced ${option}` }));
        return matches.length > 0 ? matches : null;
      }

      const matches = topLevel
        .filter((option) => option.startsWith(lower))
        .map((option) => ({ value: option, label: option }));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      await copyCodeFromLatestAssistant(ctx, args);
    },
  });

  pi.registerShortcut(extensionConfig.shortcut, {
    description: "Copy code block from latest assistant message",
    handler: async (ctx) => {
      await copyCodeFromLatestAssistant(ctx);
    },
  });
}
