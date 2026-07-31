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

// ── S6.3 · Security hardening (posture) ─────────────────────────────────────
//
// Every CONTROL already exists and is canonical: `authn/` authenticates,
// `authz/evaluator.ts` decides, `crypto/primitives.ts` hashes, RLS confines,
// `services/api/src/ratelimit` throttles, `idempotency/` deduplicates,
// `AuditService` records, and the observability backstop redacts. None of them
// is touched, wrapped or duplicated here.
//
// What was missing is the POSTURE layer: the threat model as data, the policies
// that claim controls against it, the findings a scan produces, and the report
// they add up to. Every mitigation in the platform cites a threat by number in
// a COMMENT, so nothing could answer "which of the twenty-six has no declared
// control" — the question an assessment exists to ask.
//
// It observes and enforces nothing. There is no path from here to a control.

export type { SecurityCategory, SecuritySeverity, Threat, ThreatId } from './hardening/threats.js';
export {
  isKnownThreat,
  isSecurityCategory,
  isSecuritySeverity,
  isThreatIdShape,
  SECURITY_CATEGORIES,
  SECURITY_SEVERITIES,
  SEVERITY_DEFINITIONS,
  severityRank,
  threatOf,
  THREATS,
  threatsIn,
  worstOf,
} from './hardening/threats.js';

export type { SecurityErrorCode } from './hardening/errors.js';
export {
  assertIdentifier as assertSecurityIdentifier,
  assertInstant as assertSecurityInstant,
  MAX_IDENTIFIER_LENGTH,
  SecurityError,
} from './hardening/errors.js';

export type {
  EnforcementMode,
  PolicyId,
  PolicyStatus,
  SecurityPolicy,
  SecurityRule,
} from './hardening/policy.js';
export {
  assertValidPolicy,
  assertValidRule,
  createSecurityPolicy,
  ENFORCEMENT_MODES,
  inherentSeverity,
  isEnforcementMode,
  isPolicyStatus,
  MAX_TEXT_LENGTH,
  POLICY_STATUSES,
  ruleOf,
} from './hardening/policy.js';

export type {
  FindingId,
  FindingStatus,
  SecurityFinding,
  SecurityRecommendation,
} from './hardening/finding.js';
export {
  assertValidEvidence,
  assertValidFinding,
  assertValidRecommendation,
  createSecurityFinding,
  FINDING_STATUSES,
  fingerprintOf,
  isFindingStatus,
  isUnresolved,
  MAX_EVIDENCE_KEYS,
  MAX_EVIDENCE_VALUE_LENGTH,
  UNRESOLVED_STATUSES,
} from './hardening/finding.js';

export type {
  AssessmentId,
  AssessmentScope,
  ScanResult,
  SecurityAssessment,
  SecurityCompliance,
  SecurityReport,
  SecuritySummary,
} from './hardening/assessment.js';
export {
  assertValidAssessment,
  buildSecurityReport,
  calculateCompliance,
  createSecurityAssessment,
  disappearedFindings,
  newFindings,
  summarize,
} from './hardening/assessment.js';

export type {
  AssessmentQuery,
  AssessmentSlice,
  FindingPosition,
  FindingQuery,
  FindingSlice,
  PolicyQuery,
  PolicySlice,
  SecurityAssessmentRepository,
  SecurityFindingRepository,
  SecurityPolicyRepository,
} from './hardening/repository.js';

export type {
  PostureAction,
  RecordAssessmentCommand,
  SecurityAssessmentService,
  SecurityAssessmentServiceOptions,
  SecurityPolicyService,
  SecurityPolicyServiceOptions,
} from './hardening/service.js';
export {
  createSecurityAssessmentService,
  createSecurityPolicyService,
  POSTURE_ACTIONS,
  toAuditEvent,
} from './hardening/service.js';
