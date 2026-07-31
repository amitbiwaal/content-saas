/**
 * The ports the AI controllers depend on.
 *
 * ── Why ports, and not the services themselves ──────────────────────────────
 * A controller that called `JobService.read` would need a transaction, which
 * means `services/api` would open one, which means the transport layer would
 * own a piece of the persistence story. The increment's constraint —
 * "controllers must remain transport-only" — is kept by depending on a
 * narrow read instead, and letting a composition root decide what satisfies it.
 *
 * The same reasoning applies to `AiDispatcher`. The Gateway ADMITS; S3.1 is
 * explicit that it "never executes", and nothing in it was given a dispatch
 * path. So a request that has been admitted still needs something to carry it
 * to a provider, and the honest place for that in this increment is a port: the
 * controller names the capability it needs, the composition supplies one built
 * from already-frozen parts, and when the Gateway grows its own dispatch the
 * composition changes and no controller does.
 *
 * Every port is deliberately smaller than the service behind it. A port that
 * mirrored `JobService` would let a controller create and cancel jobs, and the
 * only thing stopping it would be that nobody had written the call yet.
 */

import type { AIResponse } from '@contentos/contracts';
import type {
  AdmissionResult,
  Job,
  StreamCursor,
  StreamEvent,
  WorkflowExecution,
} from '@contentos/ai';

/**
 * Read one job, scoped to a workspace.
 *
 * The workspace is a PARAMETER rather than ambient state: a read that could
 * forget to scope itself is a cross-tenant read waiting to happen, and RLS is
 * the backstop, not the design (ADR-017). A job in another workspace returns
 * `null` — indistinguishable from one that does not exist, which is what
 * `api-principles.md` requires ("never … whether a resource exists in another
 * tenant").
 */
export interface JobReader {
  findById(workspaceId: string, jobId: string): Promise<Job | null>;
}

/** The same contract, for workflow executions. */
export interface WorkflowReader {
  findById(workspaceId: string, workflowId: string): Promise<WorkflowExecution | null>;
}

/**
 * Carry an admitted request to a provider.
 *
 * Takes an `AdmissionResult` and not a `GatewayRequest`: the only thing that
 * may be dispatched is something admission produced, and a dispatcher that
 * accepted the edge shape could be handed a request that never passed a check.
 * The type is the enforcement.
 */
export interface AiDispatcher {
  execute(admitted: AdmissionResult): Promise<AIResponse>;
  /**
   * The stream, as protocol events.
   *
   * `resume` is the position a client has already seen; events at or before it
   * are not re-emitted. Null starts from the beginning.
   */
  stream(admitted: AdmissionResult, resume: StreamCursor | null): AsyncIterable<StreamEvent>;
}
