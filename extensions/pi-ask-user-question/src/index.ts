import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

interface AskUserQuestionDetails {
  question: string;
  answer: string | null;
  cancelled: boolean;
  mode: "confirm" | "select" | "input" | "editor";
  options?: string[];
}

const AskUserQuestionParams = Type.Object({
  question: Type.String({ description: "The question to ask the user" }),
  placeholder: Type.Optional(Type.String({ description: "Placeholder text for text input" })),
  initialValue: Type.Optional(
    Type.String({ description: "Optional prefilled value. Uses the editor UI when provided." }),
  ),
  multiline: Type.Optional(Type.Boolean({ description: "Use a multi-line editor for free-form answers" })),
  confirmOnly: Type.Optional(
    Type.Boolean({ description: "Ask for a yes/no confirmation instead of collecting text" }),
  ),
  options: Type.Optional(
    Type.Array(Type.String({ description: "A selectable option" }), {
      description: "Optional list of choices for the user",
    }),
  ),
  allowCustomAnswer: Type.Optional(
    Type.Boolean({
      description: "When options are provided, allow the user to type a custom answer. Defaults to true.",
    }),
  ),
});

async function selectOptionWithShortcuts(
  ctx: {
    ui: {
      custom: <T>(
        component: (tui: any, theme: any, keybindings: any, done: (value: T) => void) => any,
      ) => Promise<T>;
    };
  },
  question: string,
  options: string[],
): Promise<string | null> {
  return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    let optionIndex = 0;
    let cachedLines: string[] | undefined;

    function refresh() {
      cachedLines = undefined;
      tui.requestRender();
    }

    function choose(index: number) {
      if (index >= 0 && index < options.length) {
        done(options[index]);
      }
    }

    function handleInput(data: string) {
      if (matchesKey(data, Key.up)) {
        optionIndex = Math.max(0, optionIndex - 1);
        refresh();
        return;
      }

      if (matchesKey(data, Key.down)) {
        optionIndex = Math.min(options.length - 1, optionIndex + 1);
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
      add(theme.fg("text", ` ${question}`));
      lines.push("");

      for (let i = 0; i < options.length; i++) {
        const selected = i === optionIndex;
        const prefix = selected ? theme.fg("accent", "> ") : "  ";
        const text = `${i + 1}. ${options[i]}`;
        add(selected ? prefix + theme.fg("accent", text) : `  ${theme.fg("text", text)}`);
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

export default function askUserQuestion(pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_user_question",
    label: "Ask User Question",
    description:
      "Ask the user a question through pi's UI and return their answer. Use this when you need clarification, a choice, or explicit confirmation.",
    promptSnippet: "Ask the user a clarifying question and wait for their answer.",
    promptGuidelines: [
      "Use this tool instead of guessing when you need missing requirements, preferences, approval, or a decision from the user.",
      "Prefer options for constrained decisions and free-form input for open-ended clarification.",
    ],
    parameters: AskUserQuestionParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        return {
          content: [{ type: "text", text: "Error: UI is not available, so the user cannot be prompted." }],
          details: {
            question: params.question,
            answer: null,
            cancelled: true,
            mode: "input",
            options: params.options,
          } satisfies AskUserQuestionDetails,
        };
      }

      if (params.confirmOnly) {
        const confirmed = await ctx.ui.confirm(params.question, params.placeholder ?? "Confirm to continue");
        return {
          content: [{ type: "text", text: confirmed ? "User confirmed: yes" : "User answered: no" }],
          details: {
            question: params.question,
            answer: confirmed ? "yes" : "no",
            cancelled: false,
            mode: "confirm",
          } satisfies AskUserQuestionDetails,
        };
      }

      const options = (params.options ?? []).filter((option) => option.trim().length > 0);
      if (options.length > 0) {
        const allowCustomAnswer = params.allowCustomAnswer !== false;
        const customLabel = "Type your own answer…";
        const displayedOptions = allowCustomAnswer ? [...options, customLabel] : options;
        const choice = await selectOptionWithShortcuts(ctx, params.question, displayedOptions);

        if (!choice) {
          return {
            content: [{ type: "text", text: "User cancelled the question." }],
            details: {
              question: params.question,
              answer: null,
              cancelled: true,
              mode: "select",
              options,
            } satisfies AskUserQuestionDetails,
          };
        }

        if (allowCustomAnswer && choice === customLabel) {
          const useEditor = params.multiline || params.initialValue !== undefined;
          const customAnswer = useEditor
            ? await ctx.ui.editor(params.question, params.initialValue ?? "")
            : await ctx.ui.input(params.question, params.placeholder);

          if (!customAnswer?.trim()) {
            return {
              content: [{ type: "text", text: "User cancelled the question." }],
              details: {
                question: params.question,
                answer: null,
                cancelled: true,
                mode: useEditor ? "editor" : "input",
                options,
              } satisfies AskUserQuestionDetails,
            };
          }

          return {
            content: [{ type: "text", text: `User answered: ${customAnswer.trim()}` }],
            details: {
              question: params.question,
              answer: customAnswer.trim(),
              cancelled: false,
              mode: useEditor ? "editor" : "input",
              options,
            } satisfies AskUserQuestionDetails,
          };
        }

        return {
          content: [{ type: "text", text: `User selected: ${choice}` }],
          details: {
            question: params.question,
            answer: choice,
            cancelled: false,
            mode: "select",
            options,
          } satisfies AskUserQuestionDetails,
        };
      }

      const useEditor = params.multiline || params.initialValue !== undefined;
      const answer = useEditor
        ? await ctx.ui.editor(params.question, params.initialValue ?? "")
        : await ctx.ui.input(params.question, params.placeholder);

      if (!answer?.trim()) {
        return {
          content: [{ type: "text", text: "User cancelled the question." }],
          details: {
            question: params.question,
            answer: null,
            cancelled: true,
            mode: useEditor ? "editor" : "input",
          } satisfies AskUserQuestionDetails,
        };
      }

      return {
        content: [{ type: "text", text: `User answered: ${answer.trim()}` }],
        details: {
          question: params.question,
          answer: answer.trim(),
          cancelled: false,
          mode: useEditor ? "editor" : "input",
        } satisfies AskUserQuestionDetails,
      };
    },
  });
}
