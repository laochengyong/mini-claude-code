import { C, safePath } from "../core/util.js";
import { WORKDIR } from "../core/config.js";

// Hooks live outside tool handlers. The loop can add permission, logging and
// stop behavior without touching each individual tool.

export type HookEvent = "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "Stop";
type HookCallback = (...args: any[]) => any;

const HOOKS: Record<HookEvent, HookCallback[]> = {
  UserPromptSubmit: [],
  PreToolUse: [],
  PostToolUse: [],
  Stop: [],
};

export function registerHook(event: HookEvent, callback: HookCallback): void {
  HOOKS[event].push(callback);
}

// First hook that returns a non-null value wins (used by the permission hook to
// deny execution). Hooks may be async; we await each in order.
export async function triggerHooks(event: HookEvent, ...args: any[]): Promise<any> {
  for (const cb of HOOKS[event]) {
    const result = await cb(...args);
    if (result != null) return result;
  }
  return null;
}

// The permission layer needs to ask the user before destructive commands. The
// terminal driver registers its asker at startup (see cli/io.ts); until one is
// registered we deny by default, so the engine never blocks on an
// unconfigured UI. This keeps hooks from depending on the CLI layer.
let permissionConfirmer: (question: string) => Promise<string> = async () => "";

export function setPermissionConfirmer(fn: (question: string) => Promise<string>): void {
  permissionConfirmer = fn;
}

const DENY_LIST = ["rm -rf /", "sudo", "shutdown", "reboot", "mkfs", "dd if="];
const DESTRUCTIVE = ["rm ", "> /etc/", "chmod 777"];

// The permission layer sees the raw tool_use before dispatch. It can deny, ask
// the user, or let execution continue.
async function permissionHook(block: any): Promise<string | null> {
  if (block.name === "bash") {
    const command = String(block.input?.command ?? "");
    for (const pattern of DENY_LIST) {
      if (command.includes(pattern)) {
        return `Permission denied: '${pattern}' is on the deny list`;
      }
    }
    if (DESTRUCTIVE.some((t) => command.includes(t))) {
      console.log(`\n${C.yellow}[permission] destructive command${C.reset}`);
      console.log(`  ${command}`);
      const choice = (await permissionConfirmer("  Allow? [y/N] ")).trim().toLowerCase();
      if (!["y", "yes"].includes(choice)) return "Permission denied by user";
    }
  }
  if (block.name === "write_file" || block.name === "edit_file") {
    const p = String(block.input?.path ?? "");
    try {
      safePath(p);
    } catch {
      return `Permission denied: path escapes workspace: ${p}`;
    }
  }
  if (typeof block.name === "string" && block.name.startsWith("mcp__") && block.name.includes("deploy")) {
    console.log(`\n${C.yellow}[permission] MCP destructive-looking tool: ${block.name}${C.reset}`);
    const choice = (await permissionConfirmer("  Allow? [y/N] ")).trim().toLowerCase();
    if (!["y", "yes"].includes(choice)) return "Permission denied by user";
  }
  return null;
}

function logHook(block: any): null {
  console.log(`${C.dim}[HOOK] ${block.name}${C.reset}`);
  return null;
}

function largeOutputHook(block: any, output: any): null {
  if (String(output).length > 100_000) {
    console.log(
      `${C.yellow}[HOOK] large output from ${block.name}: ${String(output).length} chars${C.reset}`,
    );
  }
  return null;
}

function userPromptHook(query: string): null {
  console.log(`${C.dim}[HOOK] UserPromptSubmit: ${WORKDIR}${C.reset}`);
  return null;
}

function stopHook(messages: any[]): null {
  let toolCount = 0;
  for (const msg of messages) {
    const content = msg?.content;
    if (Array.isArray(content)) {
      toolCount += content.filter(
        (item: any) => item && typeof item === "object" && item.type === "tool_result",
      ).length;
    }
  }
  console.log(`${C.dim}[HOOK] Stop: ${toolCount} tool result(s)${C.reset}`);
  return null;
}

registerHook("UserPromptSubmit", userPromptHook);
registerHook("PreToolUse", permissionHook);
registerHook("PreToolUse", logHook);
registerHook("PostToolUse", largeOutputHook);
registerHook("Stop", stopHook);
