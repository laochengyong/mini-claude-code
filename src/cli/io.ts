import * as readline from "node:readline";
import { stdin, stdout } from "node:process";
import { setCli, setPromptRedraw, PROMPT } from "../core/util.js";

// Single readline interface shared by the REPL and the permission prompt. The
// permission hook pauses the REPL question, asks the user, then resumes.

let rl: readline.Interface | null = null;
let askFn: ((q: string) => Promise<string>) | null = null;
let promptVisible = false;

export function setPromptVisible(v: boolean): void {
  promptVisible = v;
}

export function getReadline(): readline.Interface {
  if (!rl) {
    rl = readline.createInterface({ input: stdin, output: stdout, prompt: PROMPT });
    setCli(true);
    // Redraw the prompt + in-progress input only while the prompt is actually
    // being shown, so background prints during a turn don't leave stray prompts.
    setPromptRedraw(() => {
      if (promptVisible && rl) process.stdout.write(PROMPT + rl.line);
    });
    askFn = (q: string) =>
      new Promise<string>((resolve) => {
        rl!.question(q, (answer) => resolve(answer));
      });
  }
  return rl;
}

export async function askUser(question: string): Promise<string> {
  if (!askFn) return "";
  return askFn(question);
}

export function pauseForPrompt(): void {
  rl?.pause();
}

export function resumeAfterPrompt(): void {
  rl?.resume();
}

// Used by the permission hook so the question is asked cleanly, without the
// REPL's own prompt handler fighting for the line.
export async function askPermission(question: string): Promise<string> {
  if (!rl || !askFn) return "";
  rl.pause();
  const answer = await askFn(question);
  rl.resume();
  rl.prompt(true);
  return answer;
}
