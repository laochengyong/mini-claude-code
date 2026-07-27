import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";

// ── ANSI colors ──
export const C = {
  reset: "\x1b[0m",
  dim: "\x1b[90m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
};

export const PROMPT = `${C.cyan}mini >> ${C.reset}`;

// When background work (teammates, cron, background bash) prints while the user
// is mid-keystroke at the REPL, we wipe the current line, print the message,
// then redraw the prompt and whatever the user had typed so far. The redraw is
// delegated to io.ts so it only happens while the prompt is actually visible.
let cliActive = false;
let promptRedraw: (() => void) | null = null;

export function setCli(active: boolean) {
  cliActive = active;
}

export function setPromptRedraw(fn: (() => void) | null) {
  promptRedraw = fn;
}

export function terminalPrint(text: string) {
  if (!cliActive) {
    process.stdout.write(text + "\n");
    return;
  }
  process.stdout.write(`\r\x1b[K${text}\n`);
  promptRedraw?.();
}

// ── Path safety ──
// File tools stay inside the workspace (or a teammate's worktree). Bash stays
// powerful on purpose and is gated by the permission hook instead.
export function safePath(p: string, cwd?: string): string {
  const base = path.resolve(cwd ?? process.cwd());
  const resolved = path.resolve(base, p);
  const rel = path.relative(base, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

// ── Content-block helpers ──
export type ContentBlock = Anthropic.Messages.ContentBlock;
export type MessageParam = Anthropic.MessageParam;

export function blockType(block: ContentBlock | any): string {
  return typeof block?.type === "string" ? block.type : "";
}

export function extractText(content: ContentBlock[] | string): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content);
  return content
    .filter((b) => blockType(b) === "text")
    .map((b) => (b as any).text ?? "")
    .join("\n")
    .trim();
}

// Do not rely on stop_reason alone; the concrete tool_use block is the signal
// the loop keys off to decide whether another tool round is needed.
export function hasToolUse(content: ContentBlock[] | string): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((b) => blockType(b) === "tool_use");
}

export function asToolInput(input: unknown): Record<string, any> {
  return (input && typeof input === "object" ? input : {}) as Record<string, any>;
}

export function randomId(prefix: string, width = 4): string {
  const n = Math.floor(Math.random() * Math.pow(10, width));
  return `${prefix}_${Date.now()}_${String(n).padStart(width, "0")}`;
}

// Time helper: seconds since epoch as a float, mirroring time.time().
export function nowTs(): number {
  return Date.now() / 1000;
}
