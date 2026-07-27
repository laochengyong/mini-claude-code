import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { WORKDIR, WORKTREES_DIR } from "../core/config.js";
import { C, terminalPrint, nowTs } from "../core/util.js";
import { bindTaskToWorktree, loadTask, taskExists } from "./tasks.js";

// Worktree names become filesystem paths, so validation stays strict and is
// reused across create / remove / keep.
const VALID_WT_NAME = /^[A-Za-z0-9._-]{1,64}$/;

export function validateWorktreeName(name: string): string | null {
  if (!name) return "Worktree name cannot be empty";
  if (name === "." || name === "..") return `'${name}' is not a valid worktree name`;
  if (!VALID_WT_NAME.test(name)) {
    return `Invalid worktree name '${name}': only letters, digits, dots, underscores, dashes (1-64 chars)`;
  }
  return null;
}

function runGit(args: string[], cwd = WORKDIR): { ok: boolean; out: string } {
  try {
    const stdout = execFileSync("git", args, { cwd, encoding: "utf8", timeout: 30_000 });
    return { ok: true, out: stdout.trim().slice(0, 5000) || "(no output)" };
  } catch (e: any) {
    const out = ((e.stdout ?? "") + (e.stderr ?? "")).toString().trim();
    if (e.status === null && /timeout/i.test(String(e.message))) {
      return { ok: false, out: "Error: git timeout" };
    }
    return { ok: false, out: (out || e.message).slice(0, 5000) };
  }
}

function logEvent(eventType: string, worktreeName: string, taskId = ""): void {
  const eventsFile = path.join(WORKTREES_DIR, "events.jsonl");
  fs.appendFileSync(
    eventsFile,
    JSON.stringify({ type: eventType, worktree: worktreeName, task_id: taskId, ts: nowTs() }) + "\n",
  );
}

export function createWorktree(name: string, taskId = ""): string {
  // Tool-layer validation is part of the safety boundary; do it before git
  // sees the name, not only after git happens to reject it.
  const err = validateWorktreeName(name);
  if (err) return `Error: ${err}`;
  if (taskId) {
    if (!taskExists(taskId)) return `Error: task ${taskId} not found`;
  }
  const wtPath = path.join(WORKTREES_DIR, name);
  if (fs.existsSync(wtPath)) return `Worktree '${name}' already exists at ${wtPath}`;
  const { ok, out } = runGit(["worktree", "add", wtPath, "-b", `wt/${name}`, "HEAD"]);
  if (!ok) return `Git error: ${out}`;
  if (taskId) bindTaskToWorktree(taskId, name);
  logEvent("create", name, taskId);
  terminalPrint(`  ${C.yellow}[worktree] created: ${name} at ${wtPath}${C.reset}`);
  return `Worktree '${name}' created at ${wtPath}`;
}

function countWorktreeChanges(wtPath: string): { files: number; commits: number } {
  try {
    const r1 = execFileSync("git", ["status", "--porcelain"], {
      cwd: wtPath, encoding: "utf8", timeout: 10_000,
    });
    const files = r1.split("\n").filter((l) => l.trim()).length;
    let commits = 0;
    try {
      const r2 = execFileSync("git", ["log", "@{push}..HEAD", "--oneline"], {
        cwd: wtPath, encoding: "utf8", timeout: 10_000,
      });
      commits = r2.split("\n").filter((l) => l.trim()).length;
    } catch {
      commits = 0; // no upstream configured yet
    }
    return { files, commits };
  } catch {
    return { files: -1, commits: -1 };
  }
}

export function removeWorktree(name: string, discardChanges = false): string {
  const err = validateWorktreeName(name);
  if (err) return err;
  const wtPath = path.join(WORKTREES_DIR, name);
  if (!fs.existsSync(wtPath)) return `Worktree '${name}' not found`;
  if (!discardChanges) {
    const { files, commits } = countWorktreeChanges(wtPath);
    if (files < 0) return "Cannot verify status. Use discard_changes=true to force.";
    if (files > 0 || commits > 0) {
      return `Worktree '${name}' has ${files} file(s), ${commits} commit(s). Use discard_changes=true or keep_worktree.`;
    }
  }
  const r1 = runGit(["worktree", "remove", wtPath, "--force"]);
  if (!r1.ok) return `Failed to remove worktree '${name}'`;
  runGit(["branch", "-D", `wt/${name}`]);
  logEvent("remove", name);
  terminalPrint(`  ${C.yellow}[worktree] removed: ${name}${C.reset}`);
  return `Worktree '${name}' removed`;
}

export function keepWorktree(name: string): string {
  const err = validateWorktreeName(name);
  if (err) return err;
  logEvent("keep", name);
  return `Worktree '${name}' kept for review (branch: wt/${name})`;
}

export function worktreePath(name: string): string {
  return path.join(WORKTREES_DIR, name);
}

// Teammates call this to resolve a claimed task's bound directory.
export function resolveWorktreeForTask(taskId: string): string | null {
  const task = loadTask(taskId);
  return task.worktree ? worktreePath(task.worktree) : null;
}
