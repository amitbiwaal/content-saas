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

// Workspace lifecycle — the pure state machine and the capability matrix
export type {
  WorkspaceCapabilities,
  WorkspaceErrorCode,
  WorkspaceStatus,
  WorkspaceTransition,
  WorkspaceTransitionRule,
  WorkspaceTransitionTarget,
} from './workspaces/lifecycle.js';
export {
  assertWorkspaceTransitionAllowed,
  canTransitionWorkspace,
  capabilitiesOf,
  DELETION_WINDOW_DAYS,
  isWorkspaceStatus,
  QUOTA_COUNTING_STATUSES,
  resolveWorkspaceTarget,
  restoresPreviousWorkspaceStatus,
  WORKSPACE_CAPABILITIES,
  WORKSPACE_INITIAL_STATUS,
  WORKSPACE_STATUSES,
  WORKSPACE_TRANSITION_RULES,
  WORKSPACE_TRANSITIONS,
  WorkspaceError,
  workspaceTransitionsFrom,
} from './workspaces/lifecycle.js';

// Workspace settings — the storage layer; resolution belongs to settings.md
export type { WorkspaceSettings, WorkspaceSettingsKey } from './workspaces/settings.js';
export {
  changedSettingsKeys,
  DEFAULT_WORKSPACE_SETTINGS,
  WORKSPACE_SETTINGS_KEYS,
} from './workspaces/settings.js';

// Workspace events
export type {
  WorkspaceArchivedPayload,
  WorkspaceCreatedPayload,
  WorkspaceDeletionRequestedPayload,
  WorkspaceEventContext,
  WorkspaceEventPayload,
  WorkspaceEventType,
  WorkspaceReactivatedPayload,
  WorkspaceSuspendedPayload,
} from './workspaces/events.js';
export {
  WORKSPACE_AGGREGATE,
  WORKSPACE_EVENT_TYPES,
  WORKSPACE_PRODUCER,
  workspaceArchived,
  workspaceCreated,
  workspaceDeletionRequested,
  workspaceReactivated,
  workspaceSuspended,
} from './workspaces/events.js';

// Workspaces Service — provisioning, quota and lifecycle
export type {
  ProvisionedWorkspace,
  ProvisionWorkspaceCommand,
  TransitionWorkspaceCommand,
  WorkspaceAuditAction,
  WorkspaceAuditActor,
  WorkspaceExecutor,
  WorkspaceQuota,
  WorkspaceService,
  WorkspaceServiceOptions,
  WorkspaceTransitionResult,
} from './workspaces/service.js';
export {
  createWorkspaceService,
  WORKSPACE_AUDIT_ACTIONS,
  WORKSPACE_CREATING_ORG_STATUS,
  WORKSPACE_PREVIOUS_STATUS_KEY,
} from './workspaces/service.js';

// Memberships — the pure domain shared by both tiers
export type {
  MembershipErrorCode,
  MembershipProjection,
  MembershipStatus,
} from './memberships/membership.js';
export {
  canGrantOrganizationRole,
  canGrantWorkspaceRole,
  INVITATION_TTL_DAYS,
  invitationExpiry,
  isInvitationExpired,
  isMembershipStatus,
  MEMBERSHIP_STATUSES,
  MembershipError,
  ORGANIZATION_OWNER_ROLE,
  ORGANIZATION_ROLE_GRANTS,
  toRoleBinding,
  WORKSPACE_OWNER_ROLE,
  WORKSPACE_ROLE_GRANTS,
  wouldRemoveLastOwner,
} from './memberships/membership.js';

// Membership events
export type {
  MembershipAcceptedPayload,
  MembershipEventContext,
  MembershipInvitedPayload,
  MembershipRevokedPayload,
  MembershipRoleChangedPayload,
  OrganizationMembershipEventType,
  OrgMembershipAcceptedPayload,
  OrgMembershipInvitedPayload,
  OrgMembershipRevokedPayload,
  OrgMembershipRoleChangedPayload,
  WorkspaceMembershipEventType,
} from './memberships/events.js';
export {
  membershipAccepted,
  membershipInvited,
  MEMBERSHIP_PRODUCER,
  membershipRevoked,
  membershipRoleChanged,
  ORGANIZATION_MEMBERSHIP_AGGREGATE,
  ORGANIZATION_MEMBERSHIP_EVENT_TYPES,
  orgMembershipAccepted,
  orgMembershipInvited,
  orgMembershipRevoked,
  orgMembershipRoleChanged,
  WORKSPACE_MEMBERSHIP_AGGREGATE,
  WORKSPACE_MEMBERSHIP_EVENT_TYPES,
} from './memberships/events.js';

// Organization memberships
export type {
  AcceptOrganizationInvitationCommand,
  ChangeOrganizationRoleCommand,
  InviteOrganizationMemberCommand,
  MembershipActor,
  MembershipExecutor,
  MembershipResult,
  OrganizationMembership,
  OrganizationMembershipAuditAction,
  OrganizationMembershipService,
  OrganizationMembershipServiceOptions,
  RevokeOrganizationMembershipCommand,
} from './memberships/organization-memberships.js';
export {
  createOrganizationMembershipService,
  ORGANIZATION_MEMBERSHIP_AUDIT_ACTIONS,
  organizationMembershipBinding,
} from './memberships/organization-memberships.js';

// Workspace memberships
export type {
  AcceptWorkspaceInvitationCommand,
  ChangeWorkspaceRoleCommand,
  InviteWorkspaceMemberCommand,
  RevokeWorkspaceMembershipCommand,
  WorkspaceMembership,
  WorkspaceMembershipAuditAction,
  WorkspaceMembershipResult,
  WorkspaceMembershipService,
  WorkspaceMembershipServiceOptions,
} from './memberships/workspace-memberships.js';
export {
  createWorkspaceMembershipService,
  WORKSPACE_MEMBERSHIP_AUDIT_ACTIONS,
  workspaceMembershipBinding,
} from './memberships/workspace-memberships.js';

// The organization → workspace revocation cascade
export type {
  CascadeOutcome,
  CascadeRequest,
  CascadeResult,
  MembershipCascade,
  MembershipCascadeOptions,
  WorkspaceScopedRunner,
} from './memberships/cascade.js';
export { createMembershipCascade } from './memberships/cascade.js';

// Workspace settings updates — the storage layer and its append-only history
export type {
  SettingsActor,
  SettingsErrorCode,
  SettingsExecutor,
  UpdateWorkspaceSettingsCommand,
  WorkspaceSettingsResult,
  WorkspaceSettingsService,
  WorkspaceSettingsServiceOptions,
} from './settings/workspace-settings.js';
export {
  createWorkspaceSettingsService,
  SETTINGS_UPDATE_PERMISSION,
  SETTINGS_WRITABLE_STATUSES,
  WORKSPACE_SETTINGS_AUDIT_ACTION,
  WorkspaceSettingsError,
} from './settings/workspace-settings.js';
export type { SettingsEventContext, WorkspaceSettingsUpdatedPayload } from './settings/events.js';
export { WORKSPACE_SETTINGS_UPDATED, workspaceSettingsUpdated } from './settings/events.js';

// Organization → workspace suspension cascade
export type {
  CascadeSkipReason,
  OrganizationWorkspace,
  OrganizationWorkspaceRunner,
  SuspensionCascade,
  SuspensionCascadeFailure,
  SuspensionCascadeOptions,
  SuspensionCascadeRequest,
  SuspensionCascadeResult,
  SuspensionCascadeSkip,
} from './cascade/suspension.js';
export { createSuspensionCascade, ORGANIZATION_CASCADE_KEY } from './cascade/suspension.js';

// Event registry declarations — what a composition root registers.
export {
  ORGANIZATION_STREAM,
  PLATFORM_EMITTABLE_EVENT_TYPES,
  PLATFORM_EVENT_DECLARATIONS,
  PLATFORM_REGISTRY_CONTRIBUTION,
  PLATFORM_REGISTRY_SOURCE,
  WORKSPACE_STREAM,
} from './events/declarations.js';
