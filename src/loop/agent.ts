import { client } from "../core/client.js";
import {
  DEFAULT_MAX_TOKENS,
  ESCALATED_MAX_TOKENS,
  MAX_RECOVERY_RETRIES,
  CONTINUATION_PROMPT,
  RecoveryState,
  withRetry,
  isPromptTooLongError,
} from "../engine/recovery.js";
import {
  prepareContext,
  compactHistory,
  reactiveCompact,
  type Summarizer,
} from "../engine/compaction.js";
import { assembleToolPool } from "./tools.js";
import { assembleSystemPrompt, updateContext, type AgentContext } from "../engine/prompt.js";
import { triggerHooks } from "../engine/hooks.js";
import { consumeCronQueue } from "../engine/cron.js";
import {
  shouldRunBackground,
  startBackgroundTask,
  collectBackgroundResults,
} from "../engine/background.js";
import { C, terminalPrint, hasToolUse, extractText, blockType, type MessageParam } from "../core/util.js";

let roundsSinceTodo = 0;

// summarize() lets the compaction pipeline call the model without this module
// depending on the tool pool.
const summarize: Summarizer = async (conversation: string): Promise<string> => {
  const prompt =
    "Summarize this coding-agent conversation so work can continue. " +
    "Preserve current goal, key findings, changed files, remaining work, and user constraints.\n\n" +
    conversation;
  const { MODEL } = await import("../core/config.js");
  const response = await client.messages.create({
    model: MODEL,
    messages: [{ role: "user", content: prompt }],
    max_tokens: 2000,
  });
  return extractText(response.content as any) || "(empty summary)";
};

function injectBackgroundNotifications(messages: MessageParam[]): void {
  const notes = collectBackgroundResults();
  if (notes.length) {
    messages.push({
      role: "user",
      content: notes.map((n) => ({ type: "text", text: n } as any)),
    });
  }
}

async function callLlm(
  messages: MessageParam[],
  context: AgentContext,
  tools: any[],
  state: RecoveryState,
  maxTokens: number,
  live: boolean,
): Promise<any> {
  const system = assembleSystemPrompt(context);
  return withRetry(async () => {
    if (live) {
      // Stream assistant text to the terminal as it arrives. The REPL prompt
      // is not active during an interactive turn, so raw writes are safe here.
      const stream = client.messages.stream({
        model: state.currentModel,
        system,
        messages,
        tools,
        max_tokens: maxTokens,
      });
      let printed = false;
      stream.on("text", (t: string) => {
        printed = true;
        process.stdout.write(t);
      });
      const final = await stream.finalMessage();
      if (printed) process.stdout.write("\n");
      return final;
    }
    return client.messages.create({
      model: state.currentModel,
      system,
      messages,
      tools,
      max_tokens: maxTokens,
    });
  }, state);
}

// One cycle: inject scheduled/background work, prepare context, call the model,
// execute tool_use blocks, append tool_results, repeat.
export async function agentLoop(
  messages: MessageParam[],
  context: AgentContext,
  opts: { live?: boolean } = {},
): Promise<void> {
  const live = opts.live ?? false;
  const state = new RecoveryState();
  let maxTokens = DEFAULT_MAX_TOKENS;

  while (true) {
    const fired = consumeCronQueue();
    for (const job of fired) {
      messages.push({ role: "user", content: `[Scheduled] ${job.prompt}` });
      terminalPrint(`  ${C.magenta}[cron inject] ${job.prompt.slice(0, 60)}${C.reset}`);
    }
    injectBackgroundNotifications(messages);

    if (roundsSinceTodo >= 3) {
      messages.push({ role: "user", content: "<reminder>Update your todos.</reminder>" });
      roundsSinceTodo = 0;
    }

    await prepareContext(messages, summarize);
    Object.assign(context, updateContext(context));
    const { tools, handlers } = assembleToolPool();

    let response: any;
    try {
      response = await callLlm(messages, context, tools, state, maxTokens, live);
    } catch (e: any) {
      if (isPromptTooLongError(e) && !state.hasAttemptedReactiveCompact) {
        const compacted = await reactiveCompact(messages, summarize);
        messages.splice(0, messages.length, ...compacted);
        state.hasAttemptedReactiveCompact = true;
        continue;
      }
      const msg = `[Error] ${e?.name ?? "Error"}: ${e?.message ?? e}`;
      terminalPrint(`${C.red}${msg}${C.reset}`);
      messages.push({
        role: "assistant",
        content: [{ type: "text", text: msg } as any],
      });
      return;
    }

    if (response.stop_reason === "max_tokens") {
      if (!state.hasEscalated) {
        maxTokens = ESCALATED_MAX_TOKENS;
        state.hasEscalated = true;
        console.log(`  ${C.yellow}[max_tokens] retry with ${maxTokens}${C.reset}`);
        continue;
      }
      messages.push({ role: "assistant", content: response.content });
      if (state.recoveryCount < MAX_RECOVERY_RETRIES) {
        messages.push({ role: "user", content: CONTINUATION_PROMPT });
        state.recoveryCount++;
        continue;
      }
      return;
    }

    maxTokens = DEFAULT_MAX_TOKENS;
    state.hasEscalated = false;
    messages.push({ role: "assistant", content: response.content });
    if (!hasToolUse(response.content as any)) {
      await triggerHooks("Stop", messages);
      return;
    }

    const results: any[] = [];
    let compactedNow = false;
    for (const block of response.content as any[]) {
      if (block.type !== "tool_use") continue;
      console.log(`${C.cyan}> ${block.name}${C.reset}`);

      if (block.name === "compact") {
        const compacted = await compactHistory(messages, summarize);
        messages.splice(0, messages.length, ...compacted);
        messages.push({ role: "user", content: "[Compacted. Continue with summarized context.]" });
        compactedNow = true;
        break;
      }

      const blocked = await triggerHooks("PreToolUse", block);
      if (blocked) {
        results.push({ type: "tool_result", tool_use_id: block.id, content: String(blocked) });
        continue;
      }

      if (shouldRunBackground(block.name, block.input ?? {})) {
        const bgId = startBackgroundTask(block, handlers);
        const output = `[Background task ${bgId} started] Result will arrive as a task_notification.`;
        results.push({ type: "tool_result", tool_use_id: block.id, content: output });
        continue;
      }

      const handler = handlers[block.name];
      const output = String(handler ? await handler(block.input ?? {}) : `Unknown: ${block.name}`);
      await triggerHooks("PostToolUse", block, output);
      console.log(String(output).slice(0, 300));

      if (block.name === "todo_write") roundsSinceTodo = 0;
      else roundsSinceTodo++;

      results.push({ type: "tool_result", tool_use_id: block.id, content: output });
    }

    if (compactedNow) continue;
    messages.push({ role: "user", content: results });
  }
}

// Print assistant text produced during a turn (used by the cron auto-run path,
// where we don't stream because the REPL prompt may be active).
export function printTurnAssistants(messages: MessageParam[], turnStart: number): void {
  for (let i = turnStart; i < messages.length; i++) {
    if (messages[i].role !== "assistant") continue;
    const content = messages[i].content as any;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (blockType(block) === "text") {
        terminalPrint((block as any).text ?? "");
      }
    }
  }
}
