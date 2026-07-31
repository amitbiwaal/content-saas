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
export { AUTH_METHODS, isAuthMethod } from './authn/subject.js';
export type { AuthProviderAdapter, AuthenticatorOptions } from './authn/provider.js';
export { createAuthenticator } from './authn/provider.js';

// The Principal — identity RESOLVED for one request, in one workspace.
// Distinct from `Subject`, which is what a credential proves: see the header
// of `authn/principal.ts` for why permissions are never carried by a token.
export type {
  AuthContext,
  AuthenticationFailure,
  AuthenticationResult,
  AuthorizationDenial,
  AuthorizationResult,
  Principal,
} from './authn/principal.js';
export {
  AUTHENTICATION_FAILURES,
  AUTHORIZATION_DENIALS,
  freezeAuthContext,
  freezePrincipal,
  holds,
  subjectOf,
} from './authn/principal.js';

// Bearer JWT verification. HS256 only, algorithm fixed by us not the token.
export type { JwtClaims, JwtConfig, VerifyJwtOptions } from './authn/jwt.js';
export {
  DEFAULT_CLOCK_SKEW_SECONDS,
  DEFAULT_JWT_METHOD,
  JWT_ALGORITHM,
  JWT_ENV_NAMES,
  JwtConfigError,
  jwtConfigFromEnv,
  MIN_JWT_SECRET_BYTES,
  verifyJwt,
} from './authn/jwt.js';

// API keys. Peppered HMAC rather than scrypt — a 256-bit random secret needs
// no stretching, and stretching it would cost ~800 ms per request.
export type {
  ApiKeyRecord,
  ApiKeyStatus,
  ParsedApiKey,
  VerifyApiKeyOptions,
} from './authn/api-key.js';
export {
  API_KEY_ENV_NAMES,
  API_KEY_PREFIX,
  API_KEY_STATUSES,
  ApiKeyConfigError,
  apiKeyPepperFromEnv,
  hashApiKeySecret,
  MIN_API_KEY_PEPPER_BYTES,
  MIN_API_KEY_SECRET_CHARS,
  parseApiKey,
  verifyApiKey,
} from './authn/api-key.js';

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

// ── S6.2 · Operational logging & audit ──────────────────────────────────────
//
// The audit MODEL, WRITER, hash chain and `audit_log` table are canonical and
// unchanged. What was missing:
//
//   - the read half. `audit.md` §Interfaces names an `AuditReader` with four
//     methods and the code had none of them, so an investigation, an export and
//     a chain verification would each grow their own SQL.
//   - validation. `action` is specified "enumerated, never free text" and
//     nothing enforced it; `reason` is specified mandatory and the type allowed
//     an empty string.
//   - redaction on the way IN. `reason` is free text in a queryable column of
//     an append-only table kept for seven years; a token written there can
//     never be removed.
//   - the category. Every retention and review policy in `audit.md` is written
//     per category and no field carried one.
//
// Operational logs stay in `@contentos/observability`. They are a different
// stream with different retention, sampling and loss tolerance — `audit.md`
// §"Three distinct streams" — and the two models never merge.

export type {
  AuditActor,
  AuditCategory,
  AuditEvent,
  AuditMetadata,
  AuditValidationCode,
} from './audit/model.js';
export {
  assertValidAuditEvent,
  assertValidMetadata,
  assertValidTimestamp,
  AUDIT_CATEGORIES,
  AuditValidationError,
  CATEGORY_METADATA_KEY,
  categoryOf,
  isAuditActionShape,
  isAuditCategory,
  MAX_METADATA_KEYS,
  MAX_METADATA_VALUE_LENGTH,
  toNewAuditRecord,
} from './audit/model.js';

export type {
  AuditExportHandle,
  AuditPage,
  AuditPosition,
  AuditQuery,
  AuditReader,
  ChainVerification,
} from './audit/reader.js';

export type {
  AuditService,
  AuditServiceOptions,
  CredentialScanner,
  ImmutableAuditRecord,
} from './audit/service.js';
export { createAuditService, freezeAuditRecord } from './audit/service.js';
