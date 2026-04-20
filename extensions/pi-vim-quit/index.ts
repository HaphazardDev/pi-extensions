import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const quitCommands = new Set([":q", ":qa", ":wq"]);

export default function piVimQuit(pi: ExtensionAPI) {
  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") {
      return { action: "continue" } as const;
    }

    if (quitCommands.has(event.text)) {
      ctx.ui.notify("Quitting pi…", "info");
      ctx.shutdown();
      return { action: "handled" } as const;
    }

    return { action: "continue" } as const;
  });
}
