import fs from "node:fs";
import { WORKDIR, MEMORY_INDEX } from "../core/config.js";
import { listSkills } from "../state/skills.js";
import { mcpClients } from "../state/mcp.js";
import { activeTeammates } from "./teammate.js";

export interface AgentContext {
  memories: string;
  connectedMcp: string[];
  activeTeammates: string[];
}

const IDENTITY = "You are a coding agent. Act, don't explain.";
const TOOLS =
  "Available tools: bash, read_file, write_file, edit_file, glob, " +
  "todo_write, task, load_skill, compact, " +
  "create_task, list_tasks, get_task, claim_task, complete_task, " +
  "schedule_cron, list_crons, cancel_cron, " +
  "spawn_teammate, send_message, check_inbox, " +
  "request_shutdown, request_plan, review_plan, " +
  "create_worktree, remove_worktree, keep_worktree, " +
  "connect_mcp. MCP tools are prefixed mcp__{server}__{tool}.";
const WORKSPACE = `Working directory: ${WORKDIR}`;

// The system prompt is rebuilt each turn from live context. This is where
// memory, skill catalog, MCP state and active teammates become visible.
export function assembleSystemPrompt(context: AgentContext): string {
  const sections = [IDENTITY, TOOLS, WORKSPACE];
  sections.push(`Current time: ${new Date().toISOString().replace(/\.\d+Z$/, "")}`);
  sections.push(`Skills catalog:\n${listSkills()}\nUse load_skill(name) when a skill is relevant.`);
  if (context.memories) sections.push(`Relevant memories:\n${context.memories}`);
  const mcpNames = [...mcpClients.keys()];
  if (mcpNames.length) sections.push(`Connected MCP servers: ${mcpNames.join(", ")}`);
  return sections.join("\n\n");
}

export function updateContext(context: AgentContext): AgentContext {
  let memories = "";
  if (fs.existsSync(MEMORY_INDEX)) {
    memories = fs.readFileSync(MEMORY_INDEX, "utf8").slice(0, 2000);
  }
  return {
    memories,
    connectedMcp: [...mcpClients.keys()],
    activeTeammates: [...activeTeammates.keys()],
  };
}
