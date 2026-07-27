import fs from "node:fs";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { glob as globby } from "glob";
import path from "node:path";
import { safePath, C, terminalPrint } from "../../core/util.js";
import { setCurrentTodos } from "../../state/tasks.js";

const execAsync = promisify(exec);

// Bash stays powerful and is gated by the permission hook. run_in_background is
// consumed by the dispatcher; direct execution ignores it.
export async function runBash(
  command: string,
  opts: { cwd?: string; run_in_background?: boolean } = {},
): Promise<string> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: opts.cwd ?? process.cwd(),
      maxBuffer: 10 * 1024 * 1024,
      timeout: 120_000,
    });
    const out = (stdout + stderr).trim();
    return out.slice(0, 50_000) || "(no output)";
  } catch (e: any) {
    if (e.killed && /timeout/i.test(String(e.message))) return "Error: Timeout (120s)";
    const out = ((e.stdout ?? "") + (e.stderr ?? "")).trim();
    return (out || `Error: ${e.message}`).slice(0, 50_000);
  }
}

export function runRead(
  p: string,
  opts: { limit?: number; offset?: number; cwd?: string } = {},
): string {
  try {
    const fp = safePath(p, opts.cwd);
    let lines = fs.readFileSync(fp, "utf8").split(/\r?\n/);
    const offset = Math.max(Number(opts.offset ?? 0) || 0, 0);
    lines = lines.slice(offset);
    if (opts.limit != null && opts.limit < lines.length) {
      const limit = Number(opts.limit);
      lines = [...lines.slice(0, limit), `... (${lines.length - limit} more lines)`];
    }
    return lines.join("\n");
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

export function runWrite(p: string, content: string, opts: { cwd?: string } = {}): string {
  try {
    const fp = safePath(p, opts.cwd);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content);
    return `Wrote ${content.length} bytes to ${p}`;
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

export function runEdit(
  p: string,
  oldText: string,
  newText: string,
  opts: { cwd?: string } = {},
): string {
  try {
    const fp = safePath(p, opts.cwd);
    const text = fs.readFileSync(fp, "utf8");
    if (!text.includes(oldText)) return `Error: text not found in ${p}`;
    fs.writeFileSync(fp, text.replace(oldText, newText));
    return `Edited ${p}`;
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

export async function runGlob(pattern: string, opts: { cwd?: string } = {}): Promise<string> {
  try {
    const base = opts.cwd ?? process.cwd();
    const matches = await globby(pattern, { cwd: base, nodir: true });
    const safe = matches.filter((m) => {
      const resolved = path.resolve(base, m);
      const rel = path.relative(base, resolved);
      return !rel.startsWith("..") && !path.isAbsolute(rel);
    });
    return safe.length ? safe.join("\n") : "(no matches)";
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

// ── Todo ──
interface Todo {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

function normalizeTodos(todos: any): { todos: Todo[] | null; error: string | null } {
  if (typeof todos === "string") {
    try {
      todos = JSON.parse(todos);
    } catch {
      return { todos: null, error: "Error: todos must be a list or JSON array string" };
    }
  }
  if (!Array.isArray(todos)) return { todos: null, error: "Error: todos must be a list" };
  for (let i = 0; i < todos.length; i++) {
    const todo = todos[i];
    if (typeof todo !== "object" || todo === null) {
      return { todos: null, error: `Error: todos[${i}] must be an object` };
    }
    if (!("content" in todo) || !("status" in todo)) {
      return { todos: null, error: `Error: todos[${i}] missing 'content' or 'status'` };
    }
    if (!["pending", "in_progress", "completed"].includes(todo.status)) {
      return { todos: null, error: `Error: todos[${i}] has invalid status '${todo.status}'` };
    }
  }
  return { todos, error: null };
}

export function runTodoWrite(todos: any): string {
  const { todos: clean, error } = normalizeTodos(todos);
  if (error) return error;
  setCurrentTodos(clean!);
  terminalPrint(`  ${C.yellow}[todo] updated ${clean!.length} item(s)${C.reset}`);
  return `Updated ${clean!.length} todos`;
}
