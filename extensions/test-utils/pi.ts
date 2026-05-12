import { vi } from "vitest";

export function createMockPi(): any {
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const tools: any[] = [];
  const commands = new Map<string, any>();
  const shortcuts = new Map<string, any>();

  return {
    handlers,
    tools,
    commands,
    shortcuts,
    on: vi.fn((event: string, handler: (event: any, ctx: any) => any) => {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    }),
    registerTool: vi.fn((tool: any) => {
      tools.push(tool);
    }),
    registerCommand: vi.fn((name: string, command: any) => {
      commands.set(name, command);
    }),
    registerShortcut: vi.fn((shortcut: string, config: any) => {
      shortcuts.set(shortcut, config);
    }),
  };
}

export function createMockUi(overrides: Record<string, any> = {}): any {
  return {
    notify: vi.fn(),
    confirm: vi.fn(),
    input: vi.fn(),
    editor: vi.fn(),
    custom: vi.fn(),
    setStatus: vi.fn(),
    theme: {
      fg: vi.fn((_color: string, text: string) => text),
    },
    ...overrides,
  };
}

export function createMockContext(overrides: Record<string, any> = {}): any {
  const ui = overrides.ui ?? createMockUi();

  return {
    hasUI: true,
    ui,
    shutdown: vi.fn(),
    sessionManager: {
      getBranch: vi.fn(() => []),
    },
    ...overrides,
  };
}
