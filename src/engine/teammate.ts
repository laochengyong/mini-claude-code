import { client, type ToolDef } from "../core/client.js";
import { MODEL, IDLE_POLL_INTERVAL, IDLE_TIMEOUT } from "../core/config.js";
import { C, terminalPrint, hasToolUse, extractText, type MessageParam } from "../core/util.js";
import { BUS, type BusMessage } from "../state/bus.js";
import { submitPlan } from "../state/protocol.js";
import { scanUnclaimedTasks, claimTask, completeTask, listTasks, loadTask } from "../state/tasks.js";
import { resolveWorktreeForTask } from "../state/worktrees.js";
import { runBash, runRead, runWrite } from "./tools/fs.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Persistent teammate threads (here: async coroutines). They talk over the
// MessageBus, idle-poll the task board, and auto-claim work.

export const activeTeammates = new Map<string, boolean>();

const SUB_TOOLS: ToolDef[] = [
  { name: "bash", description: "Run a shell command.", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "read_file", description: "Read file.", input_schema: { type: "object", properties: { path: { type: "string" }, limit: { type: "integer" }, offset: { type: "integer" } }, required: ["path"] } },
  { name: "write_file", description: "Write file.", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "send_message", description: "Send message to another agent.", input_schema: { type: "object", properties: { to: { type: "string" }, content: { type: "string" } }, required: ["to", "content"] } },
  { name: "submit_plan", description: "Submit a plan for Lead approval.", input_schema: { type: "object", properties: { plan: { type: "string" } }, required: ["plan"] } },
  { name: "list_tasks", description: "List all tasks.", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "claim_task", description: "Claim a pending task.", input_schema: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"] } },
  { name: "complete_task", description: "Mark an in-progress task as completed.", input_schema: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"] } },
];

async function idlePoll(
  agentName: string,
  messages: MessageParam[],
  wtCtx: { path: string | null },
): Promise<"shutdown" | "work" | "timeout"> {
  // Autonomous teammates wake up for inbox messages first, then look for
  // unclaimed tasks. This keeps direct protocol messages higher priority.
  for (let i = 0; i < Math.floor(IDLE_TIMEOUT / IDLE_POLL_INTERVAL); i++) {
    await sleep(IDLE_POLL_INTERVAL * 1000);
    const inbox = BUS.readInbox(agentName);
    if (inbox.length) {
      for (const msg of inbox) {
        if (msg.type === "shutdown_request") {
          const reqId = msg.metadata?.request_id ?? "";
          BUS.send(agentName, "lead", "Shutting down.", "shutdown_response", {
            request_id: reqId,
            approve: true,
          });
          return "shutdown";
        }
      }
      messages.push({ role: "user", content: `<inbox>${JSON.stringify(inbox)}</inbox>` });
      return "work";
    }
    const unclaimed = scanUnclaimedTasks();
    if (unclaimed.length) {
      const taskData = unclaimed[0];
      const result = claimTask(taskData.id, agentName);
      if (result.startsWith("Claimed")) {
        let wtInfo = "";
        const task = loadTask(taskData.id);
        if (task.worktree) {
          const wtPath = resolveWorktreeForTask(taskData.id)!;
          wtInfo = `\nWork directory: ${wtPath}`;
          wtCtx.path = wtPath;
        }
        messages.push({
          role: "user",
          content: `<auto-claimed>Task ${taskData.id}: ${taskData.subject}${wtInfo}</auto-claimed>`,
        });
        return "work";
      }
    }
  }
  return "timeout";
}

export function spawnTeammateThread(name: string, role: string, prompt: string): string {
  if (activeTeammates.has(name)) return `Teammate '${name}' already exists`;

  const protocolCtx = { waitingPlan: null as string | null };
  const system = `You are '${name}', a ${role}. Use tools to complete tasks. If a task has a worktree, work in that directory.`;

  async function handleInboxMessage(msg: BusMessage, messages: MessageParam[]): Promise<boolean> {
    const type = msg.type ?? "message";
    const meta = msg.metadata ?? {};
    const reqId = meta.request_id ?? "";
    if (type === "shutdown_request") {
      BUS.send(name, "lead", "Shutting down.", "shutdown_response", {
        request_id: reqId,
        approve: true,
      });
      return true;
    }
    if (type === "plan_approval_response") {
      const approve = meta.approve === true;
      if (reqId === protocolCtx.waitingPlan) protocolCtx.waitingPlan = null;
      messages.push({
        role: "user",
        content: approve ? "[Plan approved]" : `[Plan rejected] ${msg.content}`,
      });
    }
    return false;
  }

  async function run(): Promise<void> {
    const wtCtx = { path: null as string | null };
    const messages: MessageParam[] = [{ role: "user", content: prompt }];

    const wtCwd = () => wtCtx.path ?? undefined;

    const handlers: Record<string, (input: Record<string, any>) => Promise<string> | string> = {
      bash: (i) => runBash(i.command, { cwd: wtCwd() }),
      read_file: (i) => runRead(i.path, { cwd: wtCwd(), limit: i.limit, offset: i.offset }),
      write_file: (i) => runWrite(i.path, i.content, { cwd: wtCwd() }),
      send_message: (i) => {
        BUS.send(name, i.to, i.content);
        return "Sent";
      },
      list_tasks: () => {
        const tasks = listTasks();
        if (!tasks.length) return "No tasks.";
        return tasks
          .map((t) => `  ${t.id}: ${t.subject} [${t.status}]${t.worktree ? ` (wt:${t.worktree})` : ""}`)
          .join("\n");
      },
      claim_task: (i) => {
        const result = claimTask(i.task_id, name);
        if (result.startsWith("Claimed")) {
          wtCtx.path = resolveWorktreeForTask(i.task_id);
        }
        return result;
      },
      complete_task: (i) => {
        const result = completeTask(i.task_id);
        wtCtx.path = null;
        return result;
      },
    };

    outer: while (true) {
      if (messages.length <= 3) {
        messages.unshift({
          role: "user",
          content: `<identity>You are '${name}', role: ${role}. Continue your work.</identity>`,
        });
      }
      let shouldShutdown = false;

      for (let step = 0; step < 10; step++) {
        const inbox = BUS.readInbox(name);
        for (const msg of inbox) {
          const stopped = await handleInboxMessage(msg, messages);
          if (stopped) {
            shouldShutdown = true;
            break;
          }
        }
        if (shouldShutdown) break;
        if (protocolCtx.waitingPlan) {
          // Poll only for protocol replies while the approval gate is closed.
          await sleep(IDLE_POLL_INTERVAL * 1000);
          continue;
        }
        if (inbox.length && !shouldShutdown) {
          const nonProtocol = inbox.filter((m) => m.type === "message");
          if (nonProtocol.length) {
            messages.push({
              role: "user",
              content: `<inbox>${JSON.stringify(nonProtocol)}</inbox>`,
            });
          }
        }
        let response: any;
        try {
          response = await client.messages.create({
            model: MODEL,
            system,
            messages: messages.slice(-20),
            tools: SUB_TOOLS as any,
            max_tokens: 8000,
          });
        } catch {
          break;
        }
        messages.push({ role: "assistant", content: response.content });
        if (!hasToolUse(response.content)) break;

        const results: any[] = [];
        for (const block of response.content as any[]) {
          if (block.type !== "tool_use") continue;
          let output: string;
          if (block.name === "submit_plan") {
            output = submitPlan(name, block.input?.plan ?? "");
            const match = /\((req_\d+)\)/.exec(output);
            protocolCtx.waitingPlan = match ? match[1] : output;
          } else {
            const handler = handlers[block.name];
            output = handler ? String(await handler(block.input ?? {})) : `Unknown: ${block.name}`;
          }
          results.push({ type: "tool_result", tool_use_id: block.id, content: String(output) });
          if (protocolCtx.waitingPlan) {
            // Ignore later tool_use blocks from the same model response; they
            // belong after approval, not before.
            break;
          }
        }
        messages.push({ role: "user", content: results });
        if (protocolCtx.waitingPlan) break;
      }

      if (shouldShutdown) break;
      if (protocolCtx.waitingPlan) continue;
      const idleResult = await idlePoll(name, messages, wtCtx);
      if (idleResult === "shutdown" || idleResult === "timeout") break;
    }

    let summary = "Done.";
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") {
        const text = extractText(messages[i].content as any);
        if (text) {
          summary = text;
          break;
        }
      }
    }
    BUS.send(name, "lead", summary, "result");
    activeTeammates.delete(name);
    terminalPrint(`  ${C.dim}[teammate] ${name} exited${C.reset}`);
  }

  activeTeammates.set(name, true);
  terminalPrint(`  ${C.magenta}[teammate] ${name} spawned as ${role}${C.reset}`);
  run().catch((e) => {
    terminalPrint(`  ${C.red}[teammate] ${name} crashed: ${e?.message ?? e}${C.reset}`);
    activeTeammates.delete(name);
  });
  return `Teammate '${name}' spawned as ${role}`;
}
