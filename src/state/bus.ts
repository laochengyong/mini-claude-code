import fs from "node:fs";
import path from "node:path";
import { MAILBOX_DIR } from "../core/config.js";
import { C, terminalPrint, nowTs } from "../core/util.js";

// Team communication is append-only JSONL mailboxes. This keeps the protocol
// inspectable on disk and lets background teammates send messages.

export interface BusMessage {
  from: string;
  to: string;
  content: string;
  type: string;
  ts: number;
  metadata: Record<string, any>;
}

class MessageBus {
  send(
    from: string,
    to: string,
    content: string,
    type = "message",
    metadata: Record<string, any> = {},
  ): void {
    const msg: BusMessage = { from, to, content, type, ts: nowTs(), metadata };
    fs.appendFileSync(path.join(MAILBOX_DIR, `${to}.jsonl`), JSON.stringify(msg) + "\n");
    terminalPrint(
      `  ${C.yellow}[bus] ${from} → ${to}: (${type}) ${content.slice(0, 50)}${C.reset}`,
    );
  }

  readInbox(agent: string): BusMessage[] {
    const inbox = path.join(MAILBOX_DIR, `${agent}.jsonl`);
    if (!fs.existsSync(inbox)) return [];
    const msgs = fs
      .readFileSync(inbox, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as BusMessage);
    fs.unlinkSync(inbox);
    return msgs;
  }
}

export const BUS = new MessageBus();

// ── Protocol state ──
// Responses are matched by request_id so one protocol reply cannot approve a
// different pending request.

export interface ProtocolState {
  requestId: string;
  type: "shutdown" | "plan_approval";
  sender: string;
  target: string;
  status: string;
  payload: string;
  createdAt: number;
}

export const pendingRequests = new Map<string, ProtocolState>();

export function newRequestId(): string {
  return `req_${String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0")}`;
}

export function matchResponse(responseType: string, requestId: string, approve: boolean): void {
  const state = pendingRequests.get(requestId);
  if (!state) return;
  if (state.type === "shutdown" && responseType !== "shutdown_response") return;
  if (state.type === "plan_approval" && responseType !== "plan_approval_response") return;
  state.status = approve ? "approved" : "rejected";
}

export function consumeLeadInbox(routeProtocol = true): BusMessage[] {
  const msgs = BUS.readInbox("lead");
  if (routeProtocol) {
    for (const msg of msgs) {
      const meta = msg.metadata || {};
      const reqId = meta.request_id ?? "";
      const type = msg.type ?? "";
      if (reqId && type.endsWith("_response")) {
        matchResponse(type, reqId, meta.approve === true);
      }
    }
  }
  return msgs;
}

export function registerPendingRequest(state: ProtocolState): void {
  pendingRequests.set(state.requestId, state);
}
