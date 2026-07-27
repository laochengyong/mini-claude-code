import {
  MAX_RETRIES,
  MAX_CONSECUTIVE_529,
  BASE_DELAY_MS,
  DEFAULT_MAX_TOKENS,
  ESCALATED_MAX_TOKENS,
  MAX_RECOVERY_RETRIES,
  FALLBACK_MODEL,
  MODEL,
  CONTINUATION_PROMPT,
} from "../core/config.js";

// Error recovery wraps the model call. It owns retry/backoff, model fallback on
// repeated overload, max_tokens escalation + continuation, and a one-shot
// reactive-compaction escape hatch for prompt-too-long errors.

export class RecoveryState {
  hasEscalated = false;
  recoveryCount = 0;
  consecutive529 = 0;
  hasAttemptedReactiveCompact = false;
  currentModel: string = MODEL;
}

function retryDelay(attempt: number): number {
  const base = Math.min(BASE_DELAY_MS * 2 ** attempt, 32000) / 1000;
  return base + Math.random() * base * 0.25;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function withRetry<T>(fn: () => Promise<T>, state: RecoveryState): Promise<T> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const result = await fn();
      state.consecutive529 = 0;
      return result;
    } catch (e: any) {
      const name = (e?.constructor?.name ?? "").toLowerCase();
      const msg = String(e?.message ?? e).toLowerCase();
      const status = e?.status ?? e?.response?.status;
      const isRateLimit = name.includes("ratelimit") || msg.includes("429") || status === 429;
      const isOverloaded = name.includes("overloaded") || msg.includes("529") || msg.includes("overloaded") || status === 529;

      if (isRateLimit) {
        const d = retryDelay(attempt);
        console.log(`  \x1b[33m[429] retry ${attempt + 1}/${MAX_RETRIES} after ${d.toFixed(1)}s\x1b[0m`);
        await sleep(d * 1000);
        continue;
      }
      if (isOverloaded) {
        state.consecutive529++;
        if (state.consecutive529 >= MAX_CONSECUTIVE_529 && FALLBACK_MODEL) {
          state.currentModel = FALLBACK_MODEL;
          state.consecutive529 = 0;
          console.log(`  \x1b[31m[529] switching to ${FALLBACK_MODEL}\x1b[0m`);
        }
        const d = retryDelay(attempt);
        console.log(`  \x1b[33m[529] retry ${attempt + 1}/${MAX_RETRIES} after ${d.toFixed(1)}s\x1b[0m`);
        await sleep(d * 1000);
        continue;
      }
      throw e;
    }
  }
  throw new Error(`Max retries (${MAX_RETRIES}) exceeded`);
}

export function isPromptTooLongError(e: any): boolean {
  const msg = String(e?.message ?? e).toLowerCase();
  return (
    (msg.includes("prompt") && msg.includes("long")) ||
    msg.includes("context_length_exceeded") ||
    msg.includes("max_context_window") ||
    e?.status === 400 && msg.includes("too long")
  );
}

export {
  DEFAULT_MAX_TOKENS,
  ESCALATED_MAX_TOKENS,
  MAX_RECOVERY_RETRIES,
  CONTINUATION_PROMPT,
};
