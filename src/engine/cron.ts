import fs from "node:fs";
import { DURABLE_PATH } from "../core/config.js";
import { C, terminalPrint } from "../core/util.js";

// Cron jobs live outside conversation history. When a job fires it becomes a
// scheduled prompt injected back into the same agent loop.

export interface CronJob {
  id: string;
  cron: string;
  prompt: string;
  recurring: boolean;
  durable: boolean;
}

export const scheduledJobs = new Map<string, CronJob>();
const cronQueue: CronJob[] = [];
const lastFired = new Map<string, string>();

function cronFieldMatches(field: string, value: number): boolean {
  if (field === "*") return true;
  if (field.startsWith("*/")) {
    const step = parseInt(field.slice(2), 10);
    return step > 0 && value % step === 0;
  }
  if (field.includes(",")) {
    return field.split(",").map((p) => p.trim()).some((p) => cronFieldMatches(p, value));
  }
  if (field.includes("-")) {
    const [lo, hi] = field.split("-", 2).map((x) => parseInt(x, 10));
    return lo <= value && value <= hi;
  }
  return value === parseInt(field, 10);
}

function cronMatches(cronExpr: string, dt: Date): boolean {
  const fields = cronExpr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [minute, hour, dom, month, dow] = fields;
  const dowVal = (dt.getDay() + 6) % 7 + 1; // Mon=1..Sun=7, matching the reference
  const m = cronFieldMatches(minute, dt.getMinutes());
  const h = cronFieldMatches(hour, dt.getHours());
  const domOk = cronFieldMatches(dom, dt.getDate());
  const monthOk = cronFieldMatches(month, dt.getMonth() + 1);
  const dowOk = cronFieldMatches(dow, dowVal);
  if (!(m && h && monthOk)) return false;
  if (dom === "*" && dow === "*") return true;
  if (dom === "*") return dowOk;
  if (dow === "*") return domOk;
  return domOk || dowOk;
}

function validateCronField(field: string, lo: number, hi: number): string | null {
  if (field === "*") return null;
  if (field.startsWith("*/")) {
    const step = field.slice(2);
    if (!/^\d+$/.test(step) || parseInt(step, 10) <= 0) return `Invalid step: ${field}`;
    return null;
  }
  if (field.includes(",")) {
    for (const part of field.split(",")) {
      const err = validateCronField(part.trim(), lo, hi);
      if (err) return err;
    }
    return null;
  }
  if (field.includes("-")) {
    const [left, right] = field.split("-", 2);
    if (!/^\d+$/.test(left) || !/^\d+$/.test(right)) return `Invalid range: ${field}`;
    const a = parseInt(left, 10);
    const b = parseInt(right, 10);
    if (a < lo || a > hi || b < lo || b > hi) return `Range ${field} out of bounds [${lo}-${hi}]`;
    if (a > b) return `Range start > end: ${field}`;
    return null;
  }
  if (!/^\d+$/.test(field)) return `Invalid field: ${field}`;
  const value = parseInt(field, 10);
  if (value < lo || value > hi) return `Value ${value} out of bounds [${lo}-${hi}]`;
  return null;
}

export function validateCron(cronExpr: string): string | null {
  const fields = cronExpr.trim().split(/\s+/);
  if (fields.length !== 5) return `Expected 5 fields, got ${fields.length}`;
  const bounds = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]] as const;
  const names = ["minute", "hour", "day-of-month", "month", "day-of-week"];
  for (let i = 0; i < 5; i++) {
    const err = validateCronField(fields[i], bounds[i][0], bounds[i][1]);
    if (err) return `${names[i]}: ${err}`;
  }
  return null;
}

function saveDurableJobs(): void {
  const durable = [...scheduledJobs.values()].filter((j) => j.durable);
  fs.writeFileSync(DURABLE_PATH, JSON.stringify(durable, null, 2));
}

export function loadDurableJobs(): void {
  if (!fs.existsSync(DURABLE_PATH)) return;
  try {
    const items = JSON.parse(fs.readFileSync(DURABLE_PATH, "utf8")) as CronJob[];
    for (const item of items) {
      if (!validateCron(item.cron)) scheduledJobs.set(item.id, item);
    }
  } catch {
    // ignore corrupt durable file
  }
}

export function scheduleJob(
  cron: string,
  prompt: string,
  recurring = true,
  durable = true,
): CronJob | string {
  const err = validateCron(cron);
  if (err) return err;
  const job: CronJob = {
    id: `cron_${String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0")}`,
    cron,
    prompt,
    recurring,
    durable,
  };
  scheduledJobs.set(job.id, job);
  if (durable) saveDurableJobs();
  return job;
}

export function cancelJob(jobId: string): string {
  const job = scheduledJobs.get(jobId);
  if (!job) return `Job ${jobId} not found`;
  scheduledJobs.delete(jobId);
  if (job.durable) saveDurableJobs();
  return `Cancelled ${jobId}`;
}

export function consumeCronQueue(): CronJob[] {
  const fired = cronQueue.splice(0, cronQueue.length);
  return fired;
}

// Scheduler tick — call once per second from a setInterval in cli/index.ts.
export function cronTick(now: Date): void {
  const marker = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  for (const job of [...scheduledJobs.values()]) {
    try {
      if (cronMatches(job.cron, now) && lastFired.get(job.id) !== marker) {
        cronQueue.push(job);
        lastFired.set(job.id, marker);
        if (!job.recurring) {
          scheduledJobs.delete(job.id);
          if (job.durable) saveDurableJobs();
        }
      }
    } catch (e: any) {
      terminalPrint(`  ${C.red}[cron error] ${job.id}: ${e.message}${C.reset}`);
    }
  }
}

// Tool wrappers
export function runScheduleCron(cron: string, prompt: string, recurring = true, durable = true): string {
  const result = scheduleJob(cron, prompt, recurring, durable);
  if (typeof result === "string") return `Error: ${result}`;
  return `Scheduled ${result.id}: '${cron}' -> ${prompt}`;
}

export function runListCrons(): string {
  if (scheduledJobs.size === 0) return "No cron jobs.";
  return [...scheduledJobs.values()]
    .map(
      (j) =>
        `  ${j.id}: '${j.cron}' -> ${j.prompt.slice(0, 40)} [${j.recurring ? "recurring" : "one-shot"}, ${j.durable ? "durable" : "session"}]`,
    )
    .join("\n");
}

export function runCancelCron(jobId: string): string {
  return cancelJob(jobId);
}

loadDurableJobs();
