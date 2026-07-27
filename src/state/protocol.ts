import { BUS, newRequestId, pendingRequests, registerPendingRequest, type ProtocolState } from "./bus.js";
import { nowTs } from "../core/util.js";

// Lead-side protocol tools. A plan approval is a real gate: after submit_plan,
// a teammate stops taking model/tool steps until the lead replies.

export function requestShutdown(teammate: string): string {
  const reqId = newRequestId();
  const state: ProtocolState = {
    requestId: reqId,
    type: "shutdown",
    sender: "lead",
    target: teammate,
    status: "pending",
    payload: "",
    createdAt: nowTs(),
  };
  registerPendingRequest(state);
  BUS.send("lead", teammate, "Shut down.", "shutdown_request", { request_id: reqId });
  return `Shutdown request sent to ${teammate}`;
}

export function requestPlan(teammate: string, task: string): string {
  BUS.send("lead", teammate, `Submit plan for: ${task}`, "message", {});
  return `Asked ${teammate} to submit a plan`;
}

export function reviewPlan(requestId: string, approve: boolean, feedback = ""): string {
  const state = pendingRequests.get(requestId);
  if (!state) return `Request ${requestId} not found`;
  state.status = approve ? "approved" : "rejected";
  BUS.send("lead", state.sender, feedback || (approve ? "Approved" : "Rejected"), "plan_approval_response", {
    request_id: requestId,
    approve,
  });
  return `Plan ${approve ? "approved" : "rejected"}`;
}

// Teammate-side: submit a plan and block until the lead responds.
export function submitPlan(fromName: string, plan: string): string {
  const reqId = newRequestId();
  const state: ProtocolState = {
    requestId: reqId,
    type: "plan_approval",
    sender: fromName,
    target: "lead",
    status: "pending",
    payload: plan,
    createdAt: nowTs(),
  };
  registerPendingRequest(state);
  BUS.send(fromName, "lead", plan, "plan_approval_request", { request_id: reqId });
  return `Plan submitted (${reqId})`;
}
