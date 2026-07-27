import path from "node:path";
import fs from "node:fs";
import dotenv from "dotenv";

// Load .env, but never let a stray token leak into a proxied request. If a
// custom base URL is set we want the SDK to authenticate with the API key, not
// an auth token — mirroring the Python reference.
dotenv.config();

if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

// The agent operates on whatever directory it was launched in, so a globally
// installed binary works against the user's project, not the install dir.
export const WORKDIR = process.cwd();

export const SKILLS_DIR = path.join(WORKDIR, "skills");
export const TRANSCRIPT_DIR = path.join(WORKDIR, ".transcripts");
export const TOOL_RESULTS_DIR = path.join(WORKDIR, ".task_outputs", "tool-results");
export const TASKS_DIR = path.join(WORKDIR, ".tasks");
export const WORKTREES_DIR = path.join(WORKDIR, ".worktrees");
export const MAILBOX_DIR = path.join(WORKDIR, ".mailboxes");
export const MEMORY_DIR = path.join(WORKDIR, ".memory");
export const MEMORY_INDEX = path.join(MEMORY_DIR, "MEMORY.md");
export const DURABLE_PATH = path.join(WORKDIR, ".scheduled_tasks.json");

for (const dir of [TASKS_DIR, WORKTREES_DIR, MAILBOX_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

export const DEFAULT_MAX_TOKENS = 8000;
export const ESCALATED_MAX_TOKENS = 16000;
export const MAX_RETRIES = 3;
export const MAX_CONSECUTIVE_529 = 2;
export const MAX_RECOVERY_RETRIES = 2;
export const BASE_DELAY_MS = 500;
export const CONTEXT_LIMIT = 50_000;
export const KEEP_RECENT_TOOL_RESULTS = 3;
export const PERSIST_THRESHOLD = 30_000;

export const CONTINUATION_PROMPT =
  "Continue from the previous response. Do not repeat completed work.";

export const MODEL = process.env.MODEL_ID!;
export const FALLBACK_MODEL = process.env.FALLBACK_MODEL_ID || null;

export const IDLE_POLL_INTERVAL = 5; // seconds
export const IDLE_TIMEOUT = 60; // seconds

if (!MODEL) {
  console.error("MODEL_ID is not set. Copy .env.example to .env and fill it in.");
  process.exit(1);
}
