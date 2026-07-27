import fs from "node:fs";
import path from "node:path";
import { TASKS_DIR } from "../core/config.js";
import { randomId, C, terminalPrint } from "../core/util.js";

// Tasks are tiny durable records. Later systems add ownership, dependencies,
// worktrees and teammates on top of this same file-backed state.

export interface Task {
  id: string;
  subject: string;
  description: string;
  status: "pending" | "in_progress" | "completed";
  owner: string | null;
  blockedBy: string[];
  worktree: string | null;
}

// In-process mirror of the session todo list (lightweight, not persisted).
export let currentTodos: any[] = [];
export function setCurrentTodos(t: any[]) {
  currentTodos = t;
}

function taskPath(taskId: string): string {
  return path.join(TASKS_DIR, `${taskId}.json`);
}

export function createTask(
  subject: string,
  description = "",
  blockedBy: string[] = [],
): Task {
  const task: Task = {
    id: `task_${randomId("t")}`,
    subject,
    description,
    status: "pending",
    owner: null,
    blockedBy,
    worktree: null,
  };
  saveTask(task);
  return task;
}

export function getTaskJson(taskId: string): string {
  return JSON.stringify(loadTask(taskId), null, 2);
}

export function saveTask(task: Task): void {
  fs.writeFileSync(taskPath(task.id), JSON.stringify(task, null, 2));
}

export function loadTask(taskId: string): Task {
  return JSON.parse(fs.readFileSync(taskPath(taskId), "utf8")) as Task;
}

export function listTasks(): Task[] {
  return fs
    .readdirSync(TASKS_DIR)
    .filter((f) => f.startsWith("task_") && f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(TASKS_DIR, f), "utf8")) as Task);
}

export function taskExists(taskId: string): boolean {
  return fs.existsSync(taskPath(taskId));
}

// Dependencies are intentionally simple: every blocker must exist and be
// completed before the task can be claimed.
export function canStart(taskId: string): boolean {
  const task = loadTask(taskId);
  for (const dep of task.blockedBy) {
    if (!taskExists(dep)) return false;
    if (loadTask(dep).status !== "completed") return false;
  }
  return true;
}

export function claimTask(taskId: string, owner = "agent"): string {
  const task = loadTask(taskId);
  if (task.status !== "pending") return `Task ${taskId} is ${task.status}, cannot claim`;
  if (task.owner) return `Task ${taskId} already owned by ${task.owner}`;
  if (!canStart(taskId)) {
    const deps = task.blockedBy.filter(
      (d) => taskExists(d) && loadTask(d).status !== "completed",
    );
    const missing = task.blockedBy.filter((d) => !taskExists(d));
    const parts: string[] = [];
    if (deps.length) parts.push(`blocked by: ${deps.join(", ")}`);
    if (missing.length) parts.push(`missing deps: ${missing.join(", ")}`);
    return `Cannot start — ${parts.join(", ")}`;
  }
  task.owner = owner;
  task.status = "in_progress";
  saveTask(task);
  terminalPrint(`  ${C.cyan}[claim] ${task.subject} → in_progress${C.reset}`);
  return `Claimed ${task.id} (${task.subject})`;
}

export function completeTask(taskId: string): string {
  const task = loadTask(taskId);
  if (task.status !== "in_progress") return `Task ${taskId} is ${task.status}, cannot complete`;
  task.status = "completed";
  saveTask(task);
  const unblocked = listTasks()
    .filter((t) => t.status === "pending" && t.blockedBy.length > 0 && canStart(t.id))
    .map((t) => t.subject);
  terminalPrint(`  ${C.green}[complete] ${task.subject} ✓${C.reset}`);
  let msg = `Completed ${task.id} (${task.subject})`;
  if (unblocked.length) msg += `\nUnblocked: ${unblocked.join(", ")}`;
  return msg;
}

export function bindTaskToWorktree(taskId: string, worktreeName: string): void {
  const task = loadTask(taskId);
  task.worktree = worktreeName;
  saveTask(task);
}

// Autonomous teammates scan the board for unclaimed, ready tasks.
export function scanUnclaimedTasks(): Task[] {
  return listTasks().filter(
    (t) => t.status === "pending" && !t.owner && canStart(t.id),
  );
}
