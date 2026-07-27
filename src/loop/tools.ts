import { C } from "../core/util.js";
import type { ToolDef } from "../core/client.js";
import { normalizeMcpName, mcpClients } from "../state/mcp.js";
import type { ToolHandler } from "../engine/background.js";

// The model sees tool schemas; we execute handlers. Both tables are explicit so
// every added capability is visible in one place.

import { runBash, runRead, runWrite, runEdit, runGlob, runTodoWrite } from "../engine/tools/fs.js";
import { spawnSubagent } from "../engine/subagent.js";
import { loadSkill } from "../state/skills.js";
import {
  createTask, listTasks, getTaskJson, claimTask, completeTask,
} from "../state/tasks.js";
import { runScheduleCron, runListCrons, runCancelCron } from "../engine/cron.js";
import { spawnTeammateThread } from "../engine/teammate.js";
import { BUS, consumeLeadInbox } from "../state/bus.js";
import { requestShutdown, requestPlan, reviewPlan } from "../state/protocol.js";
import { createWorktree, removeWorktree, keepWorktree } from "../state/worktrees.js";
import { connectMcp } from "../state/mcp.js";

export const BUILTIN_TOOLS: ToolDef[] = [
  { name: "bash", description: "Run a shell command.", input_schema: { type: "object", properties: { command: { type: "string" }, run_in_background: { type: "boolean" } }, required: ["command"] } },
  { name: "read_file", description: "Read file contents.", input_schema: { type: "object", properties: { path: { type: "string" }, limit: { type: "integer" }, offset: { type: "integer" } }, required: ["path"] } },
  { name: "write_file", description: "Write content to a file.", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "edit_file", description: "Replace exact text in a file once.", input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
  { name: "glob", description: "Find files matching a glob pattern.", input_schema: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] } },
  {
    name: "todo_write",
    description: "Create and manage a task list for the current session.",
    input_schema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          items: {
            type: "object",
            properties: { content: { type: "string" }, status: { type: "string", enum: ["pending", "in_progress", "completed"] } },
            required: ["content", "status"],
          },
        },
      },
      required: ["todos"],
    },
  },
  { name: "task", description: "Launch a focused subagent. Returns only its final summary.", input_schema: { type: "object", properties: { description: { type: "string" } }, required: ["description"] } },
  { name: "load_skill", description: "Load the full content of a skill by name.", input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "compact", description: "Summarize earlier conversation and continue with compacted context.", input_schema: { type: "object", properties: { focus: { type: "string" } }, required: [] } },
  { name: "create_task", description: "Create a task.", input_schema: { type: "object", properties: { subject: { type: "string" }, description: { type: "string" }, blockedBy: { type: "array", items: { type: "string" } } }, required: ["subject"] } },
  { name: "list_tasks", description: "List all tasks.", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "get_task", description: "Get full task details.", input_schema: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"] } },
  { name: "claim_task", description: "Claim a pending task.", input_schema: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"] } },
  { name: "complete_task", description: "Complete an in-progress task.", input_schema: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"] } },
  { name: "schedule_cron", description: "Schedule a cron job. cron is 5-field: min hour dom month dow. For one-shot reminders, compute the target minute and set recurring=false.", input_schema: { type: "object", properties: { cron: { type: "string" }, prompt: { type: "string" }, recurring: { type: "boolean" }, durable: { type: "boolean" } }, required: ["cron", "prompt"] } },
  { name: "list_crons", description: "List registered cron jobs.", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "cancel_cron", description: "Cancel a cron job by ID.", input_schema: { type: "object", properties: { job_id: { type: "string" } }, required: ["job_id"] } },
  { name: "spawn_teammate", description: "Spawn an autonomous teammate.", input_schema: { type: "object", properties: { name: { type: "string" }, role: { type: "string" }, prompt: { type: "string" } }, required: ["name", "role", "prompt"] } },
  { name: "send_message", description: "Send message to a teammate.", input_schema: { type: "object", properties: { to: { type: "string" }, content: { type: "string" } }, required: ["to", "content"] } },
  { name: "check_inbox", description: "Check inbox for messages and protocol responses.", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "request_shutdown", description: "Request a teammate to shut down.", input_schema: { type: "object", properties: { teammate: { type: "string" } }, required: ["teammate"] } },
  { name: "request_plan", description: "Ask a teammate to submit a plan.", input_schema: { type: "object", properties: { teammate: { type: "string" }, task: { type: "string" } }, required: ["teammate", "task"] } },
  { name: "review_plan", description: "Approve or reject a submitted plan.", input_schema: { type: "object", properties: { request_id: { type: "string" }, approve: { type: "boolean" }, feedback: { type: "string" } }, required: ["request_id", "approve"] } },
  { name: "create_worktree", description: "Create an isolated git worktree.", input_schema: { type: "object", properties: { name: { type: "string" }, task_id: { type: "string" } }, required: ["name"] } },
  { name: "remove_worktree", description: "Remove a worktree. Refuses if changes exist.", input_schema: { type: "object", properties: { name: { type: "string" }, discard_changes: { type: "boolean" } }, required: ["name"] } },
  { name: "keep_worktree", description: "Keep a worktree for manual review.", input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "connect_mcp", description: "Connect to an MCP server (docs, deploy) and discover tools.", input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
];

function runCreateTask(subject: string, description = "", blockedBy: string[] = []): string {
  const task = createTask(subject, description, blockedBy);
  const deps = blockedBy.length ? ` (blockedBy: ${blockedBy.join(", ")})` : "";
  console.log(`  ${C.blue}[create] ${task.subject}${deps}${C.reset}`);
  return `Created ${task.id}: ${task.subject}${deps}`;
}

function runListTasks(): string {
  const tasks = listTasks();
  if (!tasks.length) return "No tasks.";
  return tasks
    .map((t) => `  ${t.id}: ${t.subject} [${t.status}]${t.worktree ? ` (wt:${t.worktree})` : ""}`)
    .join("\n");
}

function runGetTask(taskId: string): string {
  try {
    return getTaskJson(taskId);
  } catch {
    return `Error: task ${taskId} not found`;
  }
}

function runClaimTask(taskId: string): string {
  try {
    return claimTask(taskId, "agent");
  } catch {
    return `Error: task ${taskId} not found`;
  }
}

function runCompleteTask(taskId: string): string {
  try {
    return completeTask(taskId);
  } catch {
    return `Error: task ${taskId} not found`;
  }
}

function runSendMessage(to: string, content: string): string {
  BUS.send("lead", to, content);
  return `Sent to ${to}`;
}

function runCheckInbox(): string {
  const msgs = consumeLeadInbox(true);
  if (!msgs.length) return "(inbox empty)";
  return msgs
    .map((m) => {
      const meta = m.metadata ?? {};
      const reqId = meta.request_id ?? "";
      const tag = reqId ? ` [${m.type} req:${reqId}]` : ` [${m.type}]`;
      return `  [${m.from}]${tag} ${m.content.slice(0, 200)}`;
    })
    .join("\n");
}

export const BUILTIN_HANDLERS: Record<string, ToolHandler> = {
  bash: (i) => runBash(i.command, { run_in_background: i.run_in_background }),
  read_file: (i) => runRead(i.path, { limit: i.limit, offset: i.offset }),
  write_file: (i) => runWrite(i.path, i.content),
  edit_file: (i) => runEdit(i.path, i.old_text, i.new_text),
  glob: (i) => runGlob(i.pattern),
  todo_write: (i) => runTodoWrite(i.todos),
  task: (i) => spawnSubagent(i.description),
  load_skill: (i) => loadSkill(i.name),
  create_task: (i) => runCreateTask(i.subject, i.description, i.blockedBy ?? []),
  list_tasks: () => runListTasks(),
  get_task: (i) => runGetTask(i.task_id),
  claim_task: (i) => runClaimTask(i.task_id),
  complete_task: (i) => runCompleteTask(i.task_id),
  schedule_cron: (i) => runScheduleCron(i.cron, i.prompt, i.recurring ?? true, i.durable ?? true),
  list_crons: () => runListCrons(),
  cancel_cron: (i) => runCancelCron(i.job_id),
  spawn_teammate: (i) => spawnTeammateThread(i.name, i.role, i.prompt),
  send_message: (i) => runSendMessage(i.to, i.content),
  check_inbox: () => runCheckInbox(),
  request_shutdown: (i) => requestShutdown(i.teammate),
  request_plan: (i) => requestPlan(i.teammate, i.task),
  review_plan: (i) => reviewPlan(i.request_id, i.approve, i.feedback ?? ""),
  create_worktree: (i) => createWorktree(i.name, i.task_id ?? ""),
  remove_worktree: (i) => removeWorktree(i.name, i.discard_changes ?? false),
  keep_worktree: (i) => keepWorktree(i.name),
  connect_mcp: (i) => connectMcp(i.name),
};

// Merge builtin tools + all connected MCP tools into one pool. MCP tools are
// exposed as mcp__{server}__{tool} so they share a namespace with builtins.
export function assembleToolPool(): { tools: ToolDef[]; handlers: Record<string, ToolHandler> } {
  const tools = [...BUILTIN_TOOLS];
  const handlers: Record<string, ToolHandler> = { ...BUILTIN_HANDLERS };
  for (const [serverName, mcpClient] of mcpClients) {
    const safeServer = normalizeMcpName(serverName);
    for (const toolDef of mcpClient.tools) {
      const safeTool = normalizeMcpName(toolDef.name);
      const prefixed = `mcp__${safeServer}__${safeTool}`;
      tools.push({
        name: prefixed,
        description: toolDef.description,
        input_schema: toolDef.inputSchema,
      });
      handlers[prefixed] = (args) => mcpClient.callTool(toolDef.name, args);
    }
  }
  return { tools, handlers };
}
