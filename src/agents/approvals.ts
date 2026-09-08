import { InputError } from "../errors.ts";
import { validateScope, type FeedEvent, type NewEvent } from "../events/log.ts";
import { getRun, updateRun, type RunRecord } from "./insights.ts";
import { botPermission, savePermission } from "./permissions.ts";

interface Approval { runId: string; scope: string; seq: number; decide: (allowed: boolean) => void }

// Pending grants belong to one runtime and are discarded when its tasks abort.
export function createApprovals(emit: (run: RunRecord, event: NewEvent) => FeedEvent, state: (run: RunRecord) => void) {
  const approvals = new Map<string, Approval>();

  async function approve(run: RunRecord, detail: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (botPermission(run.bot).mode === "auto") { emit(run, { kind: "approval", status: "approved", text: "Automatically approved by your Always approve setting.", detail }); return; }
    const event = emit(run, { kind: "approval", status: "pending", text: "Approve this workspace action once?", detail });
    const key = `${run.scope}:${event.seq}`;
    state(updateRun(run.id, { status: "awaiting_approval" }));
    let allowed = false;
    let onAbort: () => void = () => {};
    try {
      allowed = await new Promise<boolean>((resolve, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        approvals.set(key, { runId: run.id, scope: run.scope, seq: event.seq, decide: resolve });
      });
      signal.throwIfAborted();
      if (!allowed) throw new InputError("The owner denied this action. Do not attempt it through another route.", 403);
    } finally {
      approvals.delete(key);
      signal.removeEventListener("abort", onAbort);
      emit(run, { kind: "approval", refSeq: event.seq, status: allowed && !signal.aborted ? "approved" : "denied", text: signal.aborted ? "Approval expired when the task stopped." : allowed ? botPermission(run.bot).mode === "auto" ? "Approved by your Always approve setting." : "Approved once." : "Denied." });
      if (!signal.aborted) state(updateRun(run.id, { status: "running" }));
    }
  }

  return {
    approve,
    pending: (scope: string) => [...approvals.values()].some((approval) => approval.scope === scope),
    setPermissionMode(mode: string, bot?: string): void {
      savePermission(mode, bot);
      for (const [key, approval] of approvals) if (botPermission(getRun(approval.runId).bot).mode === "auto") { approvals.delete(key); approval.decide(true); }
    },
    decide(scope: string, seq: number, decision: string): void {
      validateScope(scope);
      if (!["approved", "denied", "always"].includes(decision)) throw new InputError("Decision must be approved, denied or always");
      const key = `${scope}:${seq}`;
      const approval = approvals.get(key);
      if (!approval) throw new InputError("Approval expired or was already decided", 410);
      if (decision === "always") { this.setPermissionMode("auto", getRun(approval.runId).bot); return; }
      approvals.delete(key);
      approval.decide(decision === "approved");
    },
  };
}
