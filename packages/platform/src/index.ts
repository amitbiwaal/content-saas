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

// Credit ledger — the immutable model
export type {
  LedgerDirection,
  LedgerEntry,
  LedgerEntryType,
  LedgerErrorCode,
} from './credits/ledger.js';
export {
  assertValidAmount,
  IMPLIED_DIRECTION,
  isLedgerDirection,
  isLedgerEntryType,
  LEDGER_DIRECTIONS,
  LEDGER_ENTRY_TYPES,
  LedgerError,
  resolveDirection,
} from './credits/ledger.js';

// Credit ledger events — payload contracts and envelope construction
export type {
  CreditAdjustedPayload,
  CreditConsumedPayload,
  CreditEventContext,
  CreditEventPayload,
  CreditEventType,
  CreditExpiredPayload,
  CreditGrantedPayload,
  CreditLedgerEventPayload,
  CreditRefundedPayload,
} from './credits/events.js';
export {
  CREDIT_ACCOUNT_AGGREGATE,
  CREDIT_EVENT_TYPES,
  CREDIT_PRODUCER,
  creditAdjusted,
  creditConsumed,
  creditEventTenantId,
  creditExpired,
  creditGranted,
  creditRefunded,
} from './credits/events.js';

// Credit Ledger Service — append, read, idempotency lookup. No balance.
export type {
  AppendEntryCommand,
  AppendResult,
  CreditLedgerService,
  CreditLedgerServiceOptions,
  LedgerActor,
  LedgerCursor,
  LedgerExecutor,
  LedgerPage,
  LedgerPageQuery,
} from './credits/service.js';
export {
  CREDIT_AUDIT_ACTIONS,
  createCreditLedgerService,
  DEFAULT_LEDGER_PAGE,
  MAX_LEDGER_PAGE,
} from './credits/service.js';

// Credit amounts — exact decimal arithmetic, never a float
export type { ScaledAmount } from './credits/amount.js';
export {
  addAmounts,
  AMOUNT_SCALE,
  compareAmounts,
  formatAmount,
  isNegative,
  isZeroOrLess,
  parseAmount,
  parseSigned,
  subtractAmounts,
  sumOrZero,
  ZERO,
} from './credits/amount.js';

// Credit holds — the reservation model
export type { CreditHold, HoldClosure, HoldErrorCode, HoldState } from './credits/holds.js';
export {
  assertFitsWithinHold,
  DEFAULT_HOLD_TTL_MS,
  HOLD_STATES,
  HoldError,
  InsufficientCreditsError,
  isHoldState,
  isTerminal,
  OPEN_HOLD_STATE,
  remainingOf,
  stateFor,
  TERMINAL_HOLD_STATES,
} from './credits/holds.js';

// Balance read model — watermarked projection with a ledger fallback
export type {
  BalanceExecutor,
  BalanceReading,
  BalanceSource,
  ProjectionResult,
  ThresholdState,
} from './credits/balance.js';
export {
  classifyThreshold,
  isThresholdState,
  parseThreshold,
  projectBalance,
  readBalance,
  reconcile,
} from './credits/balance.js';

// Hold-protocol and threshold events
export type {
  CreditHeldPayload,
  CreditHoldEventPayload,
  CreditHoldEventType,
  CreditReleasedPayload,
  CreditSettledPayload,
  CreditsThresholdPayload,
  CreditThresholdEventType,
  ReleaseCause,
} from './credits/hold-events.js';
export {
  CREDIT_HOLD_EVENT_TYPES,
  CREDIT_THRESHOLD_EVENT_TYPES,
  creditHeld,
  creditReleased,
  creditSettled,
  creditsExhausted,
  creditsLow,
} from './credits/hold-events.js';

// Credits Service — hold → consume → settle over the immutable ledger
export type {
  AuthorizationResult,
  AuthorizeSpendCommand,
  BulkReleaseCommand,
  BulkReleaseResult,
  CloseHoldCommand,
  ConsumptionResult,
  CreditsExecutor,
  CreditsService,
  CreditsServiceOptions,
  HoldClosureResult,
  RecordConsumptionCommand,
  ReleaseHoldCommand,
} from './credits/credits-service.js';
export { createCreditsService } from './credits/credits-service.js';

// Settings key registry — source-controlled, the contract for every key
export type {
  SettingDeclaration,
  SettingLayer,
  SettingScope,
  SettingsRegistry,
  SettingsResolutionErrorCode,
  SettingType,
  SettingValue,
} from './settings/registry.js';
export {
  BUILT_IN_SETTINGS,
  createSettingsRegistry,
  matchesType,
  SETTING_LAYERS,
  SETTING_TYPES,
  SettingsError,
} from './settings/registry.js';

// Settings Resolver — hierarchical resolution with provenance (ADR-024)
export type {
  InvalidateCommand,
  ResolutionScope,
  ResolvedSetting,
  SettingsAnomaly,
  SettingsResolutionExecutor,
  SettingsResolver,
  SettingsResolverOptions,
  SettingsSnapshot,
} from './settings/resolver.js';
export { createSettingsResolver } from './settings/resolver.js';

// SettingsChanged — the resolver's invalidation announcement
export type {
  SettingsChangedPayload,
  SettingsEventType,
  SettingsResolutionEventContext,
} from './settings/resolution-events.js';
export {
  SETTINGS_AGGREGATE,
  SETTINGS_CHANGED,
  SETTINGS_EVENT_TYPES,
  SETTINGS_PRODUCER,
  settingsChanged,
} from './settings/resolution-events.js';

// Feature flag registry — source-controlled, the contract for every flag
export type {
  FeatureFlagDeclaration,
  FeatureFlagErrorCode,
  FeatureFlagRegistry,
  FlagKind,
  FlagLayer,
  FlagScope,
} from './flags/registry.js';
export {
  BUILT_IN_FLAGS,
  createFeatureFlagRegistry,
  FeatureFlagError,
  FLAG_KEY_PREFIX,
  FLAG_KINDS,
  FLAG_LAYERS,
  FLAG_SCOPES,
  settingKeyFor,
} from './flags/registry.js';

// Feature Flag Resolver — evaluation over the Settings Resolver's cache
export type {
  FeatureFlagResolver,
  FeatureFlagResolverOptions,
  FlagAnomaly,
  FlagChangeCommand,
  FlagEvaluation,
  FlagSnapshot,
} from './flags/resolver.js';
export { createFeatureFlagResolver } from './flags/resolver.js';

// FeatureFlagChanged — shares the settings aggregate and stream
export type {
  FeatureFlagChangedPayload,
  FeatureFlagEventContext,
  FeatureFlagEventType,
} from './flags/events.js';
export {
  FEATURE_FLAG_CHANGED,
  FEATURE_FLAG_EVENT_TYPES,
  FEATURE_FLAG_PRODUCER,
  featureFlagChanged,
} from './flags/events.js';

// Notification registry — source-controlled, the class catalogue
export type {
  NotificationCategory,
  NotificationChannel,
  NotificationDeclaration,
  NotificationErrorCode,
  NotificationPriority,
  NotificationRegistry,
} from './notifications/registry.js';
export {
  BUILT_IN_NOTIFICATIONS,
  createNotificationRegistry,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_PRIORITIES,
  NotificationError,
} from './notifications/registry.js';

// Event → notification class mapping
export {
  dedupeKeyFor,
  NOTIFIABLE_EVENT_TYPES,
  NOTIFICATION_EVENT_MAP,
  notificationTypeFor,
  projectPayload,
} from './notifications/mapping.js';

// Notification Service — create, read, markDelivered, markFailed
export type {
  CreateNotificationCommand,
  CreateNotificationResult,
  MarkDeliveredCommand,
  MarkFailedCommand,
  MarkResult,
  NotificationActor,
  NotificationCursor,
  NotificationExecutor,
  NotificationPage,
  NotificationPageQuery,
  NotificationRecord,
  NotificationService,
  NotificationServiceOptions,
  NotificationStatus,
} from './notifications/service.js';
export {
  createNotificationService,
  DEFAULT_NOTIFICATION_PAGE,
  isNotificationStatus,
  MAX_NOTIFICATION_PAGE,
  NOTIFICATION_AUDIT_ACTIONS,
  NOTIFICATION_STATUSES,
} from './notifications/service.js';

// Event registry declarations — what a composition root registers.
export {
  CREDIT_STREAM,
  CREDITS_ORGANIZATION_RELEASE_GROUP,
  CREDITS_WORKSPACE_RELEASE_GROUP,
  NOTIFICATIONS_BILLING_GROUP,
  NOTIFICATIONS_PLATFORM_GROUP,
  ORGANIZATION_LIFECYCLE_CASCADE_GROUP,
  ORGANIZATION_MEMBERSHIP_CASCADE_GROUP,
  ORGANIZATION_STREAM,
  PLATFORM_EMITTABLE_EVENT_TYPES,
  PLATFORM_EVENT_DECLARATIONS,
  PLATFORM_REGISTRY_CONTRIBUTION,
  PLATFORM_REGISTRY_SOURCE,
  SETTINGS_STREAM,
  WORKSPACE_STREAM,
} from './events/declarations.js';

// ── S5.1 · Storage-agnostic ledger core ─────────────────────────────────────
//
// Additive to the Sprint 1 ledger, not a second one: the vocabulary bridge, the
// pure balance fold, and a port for readers that have no database.

export type { LedgerReason } from './credits/reason.js';
export {
  ENTRY_TYPE_TO_REASON,
  entryTypeFor,
  isLedgerReason,
  isRecordableReason,
  LEDGER_REASONS,
  REASON_TO_ENTRY_TYPE,
  reasonFor,
  RECORDABLE_REASONS,
} from './credits/reason.js';

export type {
  CalculateBalanceOptions,
  CreditLedger,
  LedgerBalance,
  LedgerCurrency,
  LedgerTransaction,
} from './credits/aggregate.js';
export {
  assertBalanceConsistent,
  calculateBalance,
  groupTransactions,
  LEDGER_CURRENCY,
  MAX_SCALED_BALANCE,
  reasonsOf,
  toCreditLedger,
} from './credits/aggregate.js';

export type {
  CreditLedgerRepository,
  LedgerPosition,
  LedgerQuery,
  LedgerSlice,
} from './credits/repository.js';

export type { LoadWholeLedgerOptions, WholeLedger } from './credits/walk.js';
export {
  calculateLedgerBalance,
  DEFAULT_LEDGER_PAGE_SIZE,
  DEFAULT_MAX_LEDGER_ENTRIES,
  loadWholeLedger,
} from './credits/walk.js';

// ── S5.2 · Reservation core ─────────────────────────────────────────────────
//
// Additive to the Sprint 1 hold protocol, not a second one: the commercial
// vocabulary and its transition table, the pure availability calculation, and a
// port for readers that have no database.

export type {
  CreditReservation,
  ReservationId,
  ReservationMetadata,
  ReservationStatus,
  ReservationTransition,
  ReservationTransitionRule,
} from './credits/reservation.js';
export {
  ACTIVE_RESERVATION_STATUS,
  assertExpirable,
  assertTransitionAllowed as assertReservationTransitionAllowed,
  canTransition as canReservationTransition,
  expiredAmong,
  HOLD_STATE_TO_STATUS,
  INITIAL_RESERVATION_STATUS,
  isExpired,
  isReservationStatus,
  isTerminalReservationStatus,
  RESERVATION_STATUSES,
  RESERVATION_TRANSITION_RULES,
  RESERVATION_TRANSITIONS,
  STATUS_TO_HOLD_STATE,
  statusOf,
  statusToHoldState,
  targetOf as reservationTransitionTarget,
  TERMINAL_RESERVATION_STATUSES,
  toCreditReservation,
  transitionsFrom as reservationTransitionsFrom,
} from './credits/reservation.js';

export type { AvailabilityOptions, AvailabilityReading } from './credits/availability.js';
export {
  assertSufficient,
  calculateAvailability,
  hasSufficient,
  reservedAmount,
} from './credits/availability.js';

export type {
  CloseReservationInput,
  CreditReservationRepository,
  NewReservation,
  ReservationPosition,
  ReservationQuery,
  ReservationSlice,
} from './credits/reservation-repository.js';
