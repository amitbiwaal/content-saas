/**
 * `@contentos/platform` — THE public surface.
 *
 * Specified by `04-platform/`. This is where "users, orgs, workspaces, money,
 * notifications" live (`01-system-architecture/03-high-level-architecture.md`).
 *
 * Feature-tier: it may import `contracts` and the core packages, and it may NOT
 * import another feature package. That is why the outbox is reached through the
 * `EventPublisher` interface from `contracts` rather than `@contentos/events` —
 * feature packages communicate via contracts
 * (`07-development-guide/project-structure.md` rule 4).
 */

// Organization lifecycle — the pure state machine
export type {
  OrganizationErrorCode,
  OrganizationStatus,
  OrganizationTransition,
  TransitionRule,
  TransitionTarget,
} from './organizations/lifecycle.js';
export {
  assertTransitionAllowed,
  canTransition,
  CLOSURE_WINDOW_DAYS,
  INITIAL_STATUS,
  isOrganizationStatus,
  ORGANIZATION_STATUSES,
  ORGANIZATION_TRANSITIONS,
  OrganizationError,
  resolveTarget,
  restoresPreviousStatus,
  TRANSITION_RULES,
  transitionsFrom,
} from './organizations/lifecycle.js';

// Organization events — payload contracts and envelope construction
export type {
  EventContext,
  OrganizationClosedPayload,
  OrganizationClosureRequestedPayload,
  OrganizationCreatedPayload,
  OrganizationEventPayload,
  OrganizationEventType,
  OrganizationReactivatedPayload,
  OrganizationSuspendedPayload,
} from './organizations/events.js';
export {
  ORGANIZATION_AGGREGATE,
  ORGANIZATION_EVENT_TYPES,
  ORGANIZATION_PRODUCER,
  organizationClosed,
  organizationClosureRequested,
  organizationCreated,
  organizationEventTenantId,
  organizationReactivated,
  organizationSuspended,
} from './organizations/events.js';

// Organizations Service — provisioning and lifecycle
export type {
  AuditActor,
  OrganizationAuditAction,
  OrganizationExecutor,
  OrganizationService,
  OrganizationServiceOptions,
  OrganizationTransitionResult,
  ProvisionedOrganization,
  ProvisionOrganizationCommand,
  TransitionOrganizationCommand,
} from './organizations/service.js';
export {
  createOrganizationService,
  ORGANIZATION_AUDIT_ACTIONS,
  PREVIOUS_STATUS_KEY,
} from './organizations/service.js';
