import type { ParsedThreadResponse, ReviewThread, ThreadResponseStatus } from "./types.js";

const RESPONSE_BLOCK_PATTERN = /\[\[thread:([^\]]+)\]\]([\s\S]*?)(?=\n\[\[thread:|$)/g;

function threadLocationLabel(thread: ReviewThread): string {
  if (thread.target.kind === "file") return "file";
  if (thread.target.kind === "hunk") return thread.target.hunkHeader ?? "hunk";
  if (thread.target.newLineNumber !== undefined) return `L${thread.target.newLineNumber}`;
  if (thread.target.oldLineNumber !== undefined) return `old L${thread.target.oldLineNumber}`;
  return "line";
}

function formatThreadPrompt(thread: ReviewThread): string {
  return [
    `Thread ID: ${thread.id}`,
    `File: ${thread.displayPath}`,
    `Target: ${threadLocationLabel(thread)}`,
    `Reviewer ${thread.commentKind}:`,
    thread.comment,
    "Diff excerpt:",
    "```diff",
    thread.excerpt,
    "```",
  ].join("\n");
}

export function buildDispatchPrompt(baseRef: string, threads: ReviewThread[]): string {
  const promptParts = [
    `Please address the following interactive code review thread${threads.length === 1 ? "" : "s"} against ${baseRef}.`,
    "",
    "For each thread:",
    "- inspect any code you need",
    "- make code changes when they are warranted",
    "- if the reviewer is asking a question that does not require a code change, answer it directly",
    "- after all tool use, finish with exactly one response block per thread using this format:",
    "",
    "[[thread:<id>]]",
    "Status: answered|changed|needs-follow-up",
    "Response:",
    "<your response>",
    "",
    "Do not omit any thread ids.",
    "",
  ];

  for (const thread of threads) {
    promptParts.push(formatThreadPrompt(thread), "");
  }

  return promptParts.join("\n").trim();
}

export function parseThreadResponses(text: string): Map<string, ParsedThreadResponse> {
  const responses = new Map<string, ParsedThreadResponse>();
  RESPONSE_BLOCK_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null = RESPONSE_BLOCK_PATTERN.exec(text);

  while (match) {
    const threadId = match[1]!.trim();
    const block = match[2]!.trim();
    const statusMatch = /^Status:\s*(answered|changed|needs-follow-up)\s*$/im.exec(block);
    const status = (statusMatch?.[1] ?? "answered") as ThreadResponseStatus;
    let responseText = block.replace(/^Status:.*$/im, "").replace(/^Response:\s*$/im, "").trim();
    if (responseText.length === 0) responseText = block.trim();
    responses.set(threadId, { status, responseText });
    match = RESPONSE_BLOCK_PATTERN.exec(text);
  }

  return responses;
}
