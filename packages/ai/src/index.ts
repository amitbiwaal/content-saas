/**
 * `@contentos/ai` — THE public surface.
 *
 * Specified by `08-ai-platform/`. The governed path from every caller to model
 * intelligence, and the jobs that path executes through.
 *
 * Feature-tier: it may import `contracts` and the core packages, and it may NOT
 * import another feature package. The outbox is therefore reached through the
 * `EventPublisher` interface from `contracts` rather than `@contentos/events`
 * (`07-development-guide/project-structure.md` rule 4).
 *
 * S2.1 delivers the job lifecycle only. No provider adapter, no prompt, no
 * routing, no execution.
 */

// Job lifecycle — the pure state machine
export type { Job, JobErrorCode, JobStatus, JobTransition, JobTransitionRule } from './jobs/job.js';
export {
  assertReasonPresent,
  assertTransitionAllowed,
  canTransition,
  INITIAL_JOB_STATUS,
  isJobStatus,
  isJobTransition,
  isTerminalJobStatus,
  JOB_STATUSES,
  JOB_TRANSITION_RULES,
  JOB_TRANSITIONS,
  JobError,
  targetOf,
  TERMINAL_JOB_STATUSES,
  transitionsFrom,
} from './jobs/job.js';

// Job events — payload contracts and envelope construction
export type {
  JobCancelledPayload,
  JobCompletedPayload,
  JobEventContext,
  JobEventPayload,
  JobEventType,
  JobFailedPayload,
  JobQueuedPayload,
  JobStartedPayload,
} from './jobs/events.js';
export {
  EVENT_FOR_TRANSITION,
  JOB_AGGREGATE,
  JOB_EVENT_TYPES,
  JOB_PRODUCER,
  jobCancelled,
  jobCompleted,
  jobFailed,
  jobQueued,
  jobStarted,
} from './jobs/events.js';

// Job Service — create, start, complete, fail, cancel, read
export type {
  CancelJobCommand,
  CreateJobCommand,
  FailJobCommand,
  JobActor,
  JobCursor,
  JobExecutor,
  JobPage,
  JobPageQuery,
  JobResult,
  JobService,
  JobServiceOptions,
  TransitionJobCommand,
} from './jobs/service.js';
export {
  createJobService,
  DEFAULT_JOB_PAGE,
  JOB_AUDIT_ACTIONS,
  MAX_JOB_PAGE,
} from './jobs/service.js';

// Event registry declarations — what a composition root registers.
export {
  AI_EMITTABLE_EVENT_TYPES,
  AI_EVENT_DECLARATIONS,
  AI_REGISTRY_CONTRIBUTION,
  AI_REGISTRY_SOURCE,
  JOB_RUNNER_GROUP,
  JOB_STREAM,
} from './events/declarations.js';
