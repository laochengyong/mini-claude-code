import { client, type ToolDef } from "../core/client.js";
import { MODEL, WORKDIR } from "../core/config.js";
import { hasToolUse, extractText, type MessageParam } from "../core/util.js";
import { triggerHooks } from "./hooks.js";
import { runBash, runRead, runWrite, runEdit, runGlob } from "./tools/fs.js";
import type { ToolHandler } from "./background.js";

// A one-shot subagent: its own isolated message list, intermediate steps are
// discarded, and only the final text summary is returned to the caller.

const SUB_SYSTEM = `You are a coding subagent at ${WORKDIR}. Complete the task, then return a concise final summary. Do not spawn more agents.`;

const SUB_TOOLS: ToolDef[] = [
  { name: "bash", description: "Run a shell command.", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "read_file", description: "Read file contents.", input_schema: { type: "object", properties: { path: { type: "string" }, limit: { type: "integer" }, offset: { type: "integer" } }, required: ["path"] } },
  { name: "write_file", description: "Write content to a file.", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "edit_file", description: "Replace exact text in a file once.", input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
  { name: "glob", description: "Find files matching a glob pattern.", input_schema: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] } },
];

const SUB_HANDLERS: Record<string, ToolHandler> = {
  bash: (i) => runBash(i.command, i),
  read_file: (i) => runRead(i.path, i),
  write_file: (i) => runWrite(i.path, i.content, i),
  edit_file: (i) => runEdit(i.path, i.old_text, i.new_text, i),
  glob: (i) => runGlob(i.pattern, i),
};

export async function spawnSubagent(description: string): Promise<string> {
  const messages: MessageParam[] = [{ role: "user", content: description }];
  for (let i = 0; i < 30; i++) {
    const response = await client.messages.create({
      model: MODEL,
      system: SUB_SYSTEM,
      messages,
      tools: SUB_TOOLS as any,
      max_tokens: 8000,
    });
    messages.push({ role: "assistant", content: response.content as any });
    if (!hasToolUse(response.content as any)) break;

    const results: any[] = [];
    for (const block of response.content as any[]) {
      if (block.type !== "tool_use") continue;
      const blocked = await triggerHooks("PreToolUse", block);
      let output: string;
      if (blocked) {
        output = String(blocked);
      } else {
        const handler = SUB_HANDLERS[block.name];
        output = handler ? String(await handler(block.input ?? {})) : `Unknown: ${block.name}`;
        await triggerHooks("PostToolUse", block, output);
      }
      results.push({ type: "tool_result", tool_use_id: block.id, content: output });
    }
    messages.push({ role: "user", content: results });
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      const text = extractText(messages[i].content as any);
      if (text) return text;
    }
  }
  return "Subagent finished without a text summary.";
}
