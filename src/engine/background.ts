import { C, terminalPrint, type ContentBlock } from "../core/util.js";
import { triggerHooks } from "./hooks.js";

// Slow tools return a placeholder tool_result immediately. Their real output is
// later injected as a task_notification so the main loop can keep moving.

let bgCounter = 0;
interface BgTask {
  toolUseId: string;
  command: string;
  status: "running" | "completed";
}
const backgroundTasks = new Map<string, BgTask>();
const backgroundResults = new Map<string, string>();

export function isSlowOperation(toolName: string, toolInput: Record<string, any>): boolean {
  if (toolName !== "bash") return false;
  const command = String(toolInput.command ?? "").toLowerCase();
  const slow = [
    "install", "build", "test", "deploy", "compile",
    "docker build", "pip install", "npm install",
    "cargo build", "pytest", "make",
  ];
  return slow.some((k) => command.includes(k));
}

export function shouldRunBackground(toolName: string, toolInput: Record<string, any>): boolean {
  if (toolName !== "bash") return false;
  return Boolean(toolInput.run_in_background) || isSlowOperation(toolName, toolInput);
}

export type ToolHandler = (input: Record<string, any>) => string | Promise<string>;

export function startBackgroundTask(
  block: Extract<ContentBlock, { type: "tool_use" }> | any,
  handlers: Record<string, ToolHandler>,
): string {
  bgCounter++;
  const bgId = `bg_${String(bgCounter).padStart(4, "0")}`;
  const command = block.input?.command ?? block.name;
  backgroundTasks.set(bgId, { toolUseId: block.id, command: String(command), status: "running" });

  const handler = handlers[block.name];
  Promise.resolve()
    .then(() => (handler ? handler(block.input ?? {}) : `Unknown: ${block.name}`))
    .then((result) => {
      triggerHooks("PostToolUse", block, result);
      const task = backgroundTasks.get(bgId);
      if (task) task.status = "completed";
      backgroundResults.set(bgId, String(result));
    })
    .catch((e) => {
      const task = backgroundTasks.get(bgId);
      if (task) task.status = "completed";
      backgroundResults.set(bgId, `Error: ${e?.message ?? e}`);
    });

  terminalPrint(`  ${C.yellow}[background] ${bgId}: ${String(command).slice(0, 60)}${C.reset}`);
  return bgId;
}

export function collectBackgroundResults(): string[] {
  const ready = [...backgroundTasks.entries()]
    .filter(([, t]) => t.status === "completed")
    .map(([id]) => id);
  const notifications: string[] = [];
  for (const bgId of ready) {
    const task = backgroundTasks.get(bgId)!;
    const output = backgroundResults.get(bgId) ?? "";
    backgroundTasks.delete(bgId);
    backgroundResults.delete(bgId);
    const summary = output.length > 200 ? output.slice(0, 200) : output;
    notifications.push(
      `<task_notification>\n  <task_id>${bgId}</task_id>\n  <status>completed</status>\n  <command>${task.command}</command>\n  <summary>${summary}</summary>\n</task_notification>`,
    );
  }
  return notifications;
}
