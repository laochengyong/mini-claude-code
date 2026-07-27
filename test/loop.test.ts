// Offline validation of the agent loop's tool dispatch. Stubs the model so we
// exercise hooks → permission → handler → tool_result → stop without an API key.
import fs from "node:fs";
import path from "node:path";
import { client } from "../src/core/client.js";
import { agentLoop } from "../src/loop/agent.js";
import { updateContext } from "../src/engine/prompt.js";
import type { MessageParam } from "../src/core/util.js";

const HELLO = path.join(process.cwd(), "hello.test.txt");
if (fs.existsSync(HELLO)) fs.unlinkSync(HELLO);

const sequence = [
  {
    stop_reason: "tool_use",
    content: [
      { type: "tool_use", id: "t1", name: "write_file", input: { path: "hello.test.txt", content: "hi from mini-claude-code" } },
    ],
  },
  {
    stop_reason: "end_turn",
    content: [{ type: "text", text: "wrote the file." }],
  },
];
let i = 0;
// @ts-expect-error - replacing the SDK method for the test
client.messages.create = async () => sequence[i++];

const messages: MessageParam[] = [{ role: "user", content: "write hello.test.txt" }];
const context = updateContext({ memories: "", connectedMcp: [], activeTeammates: [] });

await agentLoop(messages, context, { live: false });

const ok =
  fs.existsSync(HELLO) &&
  fs.readFileSync(HELLO, "utf8") === "hi from mini-claude-code" &&
  messages.some(
    (m) =>
      m.role === "user" &&
      Array.isArray(m.content) &&
      m.content.some((b: any) => b.type === "tool_result" && /Wrote \d+ bytes to hello\.test\.txt/.test(b.content)),
  );

fs.unlinkSync(HELLO);
if (ok) {
  console.log("PASS: tool dispatch wrote the file and returned a tool_result");
  process.exit(0);
} else {
  console.log("FAIL");
  console.log(JSON.stringify(messages, null, 2));
  process.exit(1);
}
