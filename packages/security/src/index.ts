/**
 * `@contentos/security` — THE public surface.
 *
 * Specified by `16-security/`. Reusable security primitives only: no business
 * logic, no UI, no API handlers.
 *
 * NOTE what is deliberately NOT exported: `AuthProviderAdapter`'s concrete
 * Better Auth implementation. The provider is never visible outside this
 * package (`16-security/authentication.md`).
 */

// Tenant context
export type {
  MembershipResolver,
  ResourceRef,
  TenantContext,
  TenantContextFactory,
  TenantContextFactoryOptions,
  TenantContextSource,
  TenantIsolation,
} from './tenant/context.js';
export {
  createTenantContextFactory,
  TenantContextError,
  tenantIsolation,
  validateTenantContext,
} from './tenant/context.js';

// Identity and sessions
export type {
  AuthMethod,
  AuthResult,
  Authenticator,
  Credential,
  DeviceRecord,
  MfaFactor,
  ReuseDetected,
  Session,
  SessionRevocationReason,
  SessionState,
  StepUpResult,
  Subject,
  TokenPair,
} from './authn/subject.js';
export {
  isSessionUsable,
  MFA_REVERIFY_SECONDS,
  SESSION_ABSOLUTE_SECONDS,
  SESSION_IDLE_SECONDS,
  sessionState,
  slideIdleExpiry,
  stepUpRequired,
} from './authn/subject.js';
export type { AuthProviderAdapter, AuthenticatorOptions } from './authn/provider.js';
export { createAuthenticator } from './authn/provider.js';

// MFA
export type {
  MfaEnrolment,
  MfaFactorKind,
  MfaPolicy,
  MfaPolicyInput,
  MfaRequirement,
  MfaState,
  RecoveryCodeResult,
} from './authn/mfa.js';
export {
  decodeBase32,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCodes,
  hotp,
  mfaRequirement,
  RECOVERY_CODE_COUNT,
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
  TOTP_SKEW_STEPS,
  totpAt,
  totpEnrolmentUri,
  verifyRecoveryCode,
  verifyTotp,
} from './authn/mfa.js';

// Authorization
export type {
  ActionName,
  OrganizationRole,
  Permission,
  ResourceKind,
  RoleCatalogue,
  RoleName,
  RoleTier,
  WorkspaceRole,
} from './authz/permissions.js';
export {
  ACTION_NAMES,
  CONTENT_PERMISSIONS,
  isValidPermission,
  ORGANIZATION_ROLES,
  PERMISSIONS,
  RESOURCE_KINDS,
  ROLE_PERMISSIONS,
  roleCatalogue,
  tierOf,
  WORKSPACE_ROLES,
} from './authz/permissions.js';
export type {
  AuthorizationDecision,
  AuthorizationService,
  DenyReason,
  EvaluationInput,
  RoleBinding,
} from './authz/evaluator.js';
export {
  assertValidBinding,
  AuthorizationError,
  authorizationService,
  evaluate,
  isBindingActive,
  resolvePermissions,
} from './authz/evaluator.js';

// Audit
export type {
  AuditActorKind,
  AuditContext,
  AuditRecord,
  AuditResult,
  AuditTableProbe,
  AuditTarget,
  AuditWriter,
  AuditWriterOptions,
  NewAuditRecord,
  QueueingAuditWriterHandle,
  Transaction,
} from './audit/writer.js';
export type { AuditExecutor, PersistentAuditWriterOptions } from './audit/persistent-writer.js';
export { createPersistentAuditWriter } from './audit/persistent-writer.js';
export {
  createAuditWriter,
  DEFAULT_MAX_BUFFERED,
  GENESIS_HASH,
  hashAuditRecord,
  verifyChainLink,
} from './audit/writer.js';

// Crypto
export {
  constantTimeEquals,
  hashSecret,
  hmacSha1,
  hmacSha256,
  needsRehash,
  secureId,
  secureRandomInt,
  secureToken,
  verifySecret,
} from './crypto/primitives.js';
