#!/usr/bin/env node
import { getReadline, setPromptVisible, askPermission } from "./io.js";
import { C, PROMPT, terminalPrint } from "../core/util.js";
import { triggerHooks, setPermissionConfirmer } from "../engine/hooks.js";
import { agentLoop, printTurnAssistants } from "../loop/agent.js";
import { updateContext, type AgentContext } from "../engine/prompt.js";
import { consumeLeadInbox } from "../state/bus.js";
import { cronTick, consumeCronQueue } from "../engine/cron.js";
import { scanSkills } from "../state/skills.js";
import type { MessageParam } from "../core/util.js";

// Re-scan skills on start so newly added SKILL.md files are picked up.
scanSkills();

const rl = getReadline();
// Wire the terminal asker into the permission hook. Until this runs the hook
// denies destructive commands by default, so the engine never blocks on a UI
// that hasn't been set up.
setPermissionConfirmer(askPermission);

const history: MessageParam[] = [];
const context: AgentContext = updateContext({ memories: "", connectedMcp: [], activeTeammates: [] });

// Serialize agent turns between the REPL and the cron auto-run loop. Node is
// single-threaded but async, so this is a promise chain acting as a mutex.
let chain: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(() => fn());
  chain = run.catch(() => {});
  return run;
}

// cron auto-run: the scheduler ticks every second; when a job fires it injects
// its prompt and runs a (non-live) agent turn under the lock.
setInterval(() => {
  cronTick(new Date());
  const fired = consumeCronQueue();
  if (fired.length === 0) return;
  void withLock(async () => {
    const turnStart = history.length;
    for (const job of fired) {
      history.push({ role: "user", content: `[Scheduled] ${job.prompt}` });
      terminalPrint(`  ${C.magenta}[cron auto] ${job.prompt.slice(0, 60)}${C.reset}`);
    }
    await agentLoop(history, context, { live: false });
    Object.assign(context, updateContext(context));
    printTurnAssistants(history, turnStart);
    rl.prompt(true);
  });
}, 1000);

let processing = false;

async function handleLine(query: string): Promise<void> {
  if (["q", "exit", "quit", ""].includes(query.trim().toLowerCase())) {
    rl.close();
    return;
  }
  if (processing) return; // ignore lines typed mid-turn
  processing = true;
  setPromptVisible(false);

  await triggerHooks("UserPromptSubmit", query);
  const turnStart = history.length;
  history.push({ role: "user", content: query });

  await withLock(async () => {
    await agentLoop(history, context, { live: true });
    Object.assign(context, updateContext(context));
  });

  // Surface any protocol/inbox messages that landed during the turn.
  const inbox = consumeLeadInbox(true);
  if (inbox.length) {
    const inboxText = inbox
      .map((m) => {
        const reqId = m.metadata?.request_id ?? "";
        const suffix = reqId ? ` req:${reqId}` : "";
        return `From ${m.from} [${m.type ?? "message"}${suffix}]: ${m.content.slice(0, 200)}`;
      })
      .join("\n");
    history.push({ role: "user", content: `[Inbox]\n${inboxText}` });
  }

  processing = false;
  setPromptVisible(true);
  rl.prompt(true);
}

console.log("mini-claude-code: a small but complete coding-agent harness");
console.log("Enter a question, press Enter to send. Type q to quit.\n");
setPromptVisible(true);
rl.prompt();

rl.on("line", (line: string) => {
  void handleLine(line);
});
rl.on("close", () => process.exit(0));
rl.on("SIGINT", () => process.exit(0));

void PROMPT;
