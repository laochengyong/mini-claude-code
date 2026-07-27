import fs from "node:fs";
import path from "node:path";
import { TRANSCRIPT_DIR, TOOL_RESULTS_DIR, PERSIST_THRESHOLD, KEEP_RECENT_TOOL_RESULTS, CONTEXT_LIMIT } from "../core/config.js";
import { blockType, type MessageParam } from "../core/util.js";

// Compaction is layered: first shrink oversized tool results, then trim old
// message ranges, then compact old tool_result blocks, and only call the
// model for a summary when context is still too large or the model asks.

export function estimateSize(messages: MessageParam[]): number {
  return JSON.stringify(messages).length;
}

function messageHasToolUse(message: MessageParam): boolean {
  if (message.role !== "assistant") return false;
  const content = message.content as any;
  if (!Array.isArray(content)) return false;
  return content.some((b) => blockType(b) === "tool_use");
}

function isToolResultMessage(message: MessageParam): boolean {
  if (message.role !== "user") return false;
  const content = message.content as any;
  if (!Array.isArray(content)) return false;
  return content.some((b) => b && typeof b === "object" && b.type === "tool_result");
}

interface FoundBlock {
  mi: number;
  bi: number;
  block: any;
}

function collectToolResults(messages: MessageParam[]): FoundBlock[] {
  const found: FoundBlock[] = [];
  messages.forEach((msg, mi) => {
    const content = msg.content as any;
    if (msg.role !== "user" || !Array.isArray(content)) return;
    content.forEach((block: any, bi: number) => {
      if (block && typeof block === "object" && block.type === "tool_result") {
        found.push({ mi, bi, block });
      }
    });
  });
  return found;
}

export function persistLargeOutput(toolUseId: string, output: string): string {
  if (output.length <= PERSIST_THRESHOLD) return output;
  fs.mkdirSync(TOOL_RESULTS_DIR, { recursive: true });
  const p = path.join(TOOL_RESULTS_DIR, `${toolUseId}.txt`);
  if (!fs.existsSync(p)) fs.writeFileSync(p, output);
  return `<persisted-output>\nFull output: ${p}\nPreview:\n${output.slice(0, 2000)}\n</persisted-output>`;
}

// Shrink the largest tool_result blocks of the last user message down to a
// persisted-output stub until the total fits the budget.
export function toolResultBudget(messages: MessageParam[], maxBytes = 200_000): MessageParam[] {
  if (messages.length === 0) return messages;
  const last = messages[messages.length - 1];
  const content = last.content as any;
  if (last.role !== "user" || !Array.isArray(content)) return messages;
  const blocks = content
    .map((b: any, i: number) => ({ i, b }))
    .filter((x) => x.b && typeof x.b === "object" && x.b.type === "tool_result");
  let total = blocks.reduce((sum, x) => sum + String(x.b.content ?? "").length, 0);
  if (total <= maxBytes) return messages;
  const sorted = [...blocks].sort(
    (a, b) => String(b.b.content ?? "").length - String(a.b.content ?? "").length,
  );
  for (const entry of sorted) {
    if (total <= maxBytes) break;
    const text = String(entry.b.content ?? "");
    entry.b.content = persistLargeOutput(entry.b.tool_use_id ?? "unknown", text);
    total = blocks.reduce((sum, x) => sum + String(x.b.content ?? "").length, 0);
  }
  return messages;
}

// Drop a middle range of messages, keeping a small head and tail. The head/tail
// boundaries are nudged so we never split a tool_use from its tool_result.
export function snipCompact(messages: MessageParam[], maxMessages = 50): MessageParam[] {
  if (messages.length <= maxMessages) return messages;
  let headEnd = 3;
  let tailStart = messages.length - (maxMessages - 3);
  if (headEnd > 0 && messageHasToolUse(messages[headEnd - 1])) {
    while (headEnd < messages.length && isToolResultMessage(messages[headEnd])) headEnd++;
  }
  if (
    tailStart > 0 &&
    tailStart < messages.length &&
    isToolResultMessage(messages[tailStart]) &&
    messageHasToolUse(messages[tailStart - 1])
  ) {
    tailStart--;
  }
  if (headEnd >= tailStart) return messages;
  const snipped = tailStart - headEnd;
  return [
    ...messages.slice(0, headEnd),
    { role: "user", content: `[snipped ${snipped} messages]` },
    ...messages.slice(tailStart),
  ];
}

// Replace old tool_result bodies with a compacted stub, keeping the most recent.
export function microCompact(messages: MessageParam[]): MessageParam[] {
  const toolResults = collectToolResults(messages);
  if (toolResults.length <= KEEP_RECENT_TOOL_RESULTS) return messages;
  const stale = toolResults.slice(0, toolResults.length - KEEP_RECENT_TOOL_RESULTS);
  for (const { block } of stale) {
    if (String(block.content ?? "").length > 120) {
      block.content = "[Earlier tool result compacted. Re-run if needed.]";
    }
  }
  return messages;
}

export function writeTranscript(messages: MessageParam[]): string {
  fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  const p = path.join(TRANSCRIPT_DIR, `transcript_${Math.floor(Date.now() / 1000)}.jsonl`);
  fs.writeFileSync(p, messages.map((m) => JSON.stringify(m)).join("\n") + "\n");
  return p;
}

export interface Summarizer {
  (conversation: string): Promise<string>;
}

export async function compactHistory(
  messages: MessageParam[],
  summarize: Summarizer,
): Promise<MessageParam[]> {
  const transcript = writeTranscript(messages);
  // eslint-disable-next-line no-console
  console.log(`  \x1b[36m[compact] transcript saved: ${transcript}\x1b[0m`);
  const summary = await summarize(JSON.stringify(messages).slice(0, 80000));
  return [{ role: "user", content: `[Compacted]\n\n${summary}` }];
}

export async function reactiveCompact(
  messages: MessageParam[],
  summarize: Summarizer,
): Promise<MessageParam[]> {
  const transcript = writeTranscript(messages);
  // eslint-disable-next-line no-console
  console.log(`  \x1b[31m[reactive compact] transcript saved: ${transcript}\x1b[0m`);
  let tailStart = Math.max(0, messages.length - 5);
  if (
    tailStart > 0 &&
    tailStart < messages.length &&
    isToolResultMessage(messages[tailStart]) &&
    messageHasToolUse(messages[tailStart - 1])
  ) {
    tailStart--;
  }
  let summary: string;
  try {
    summary = await summarize(JSON.stringify(messages.slice(0, tailStart)).slice(0, 80000));
  } catch {
    summary = "Earlier conversation was trimmed after a prompt-too-long error.";
  }
  return [
    { role: "user", content: `[Reactive compact]\n\n${summary}` },
    ...messages.slice(tailStart),
  ];
}

// The full pre-LLM pipeline. mutate via splice so callers keep the same array.
export async function prepareContext(
  messages: MessageParam[],
  summarize: Summarizer,
): Promise<MessageParam[]> {
  let m = toolResultBudget(messages);
  m = snipCompact(m);
  m = microCompact(m);
  if (estimateSize(m) > CONTEXT_LIMIT) {
    m = await compactHistory(m, summarize);
  }
  // copy back into the caller's array
  messages.splice(0, messages.length, ...m);
  return messages;
}
