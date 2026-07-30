/**
 * `@contentos/contracts` — THE public surface.
 *
 * This is the only barrel file. Anything not exported here is internal, and
 * `exports` in package.json blocks deep imports
 * (`07-development-guide/project-structure.md` rule 6).
 *
 * This package has ZERO dependencies and may import nothing. That is what makes
 * it usable everywhere including the browser bundle; one dependency on
 * `database` would pull Drizzle into the frontend build (rule 3).
 */

// Events — `13-event-platform/event-apis.md`
export type { DomainEvent, EnvelopeField } from './events/envelope.js';
export { ENVELOPE_FIELDS } from './events/envelope.js';
export type { EventPublisher, OutboxPublisher } from './events/publisher.js';
export type {
  ConsumerDeclaration,
  Criticality,
  EventTenantScope,
  EventTypeDeclaration,
  RegistryContribution,
  UnknownVersionPolicy,
  VersionState,
} from './events/registry.js';
export { EVENT_TENANT_SCOPES, isEventTenantScope } from './events/registry.js';
export type {
  BarrierToken,
  BusEntryId,
  BusPosition,
  JobContext,
  Page,
  ReplayAttemptOutcome,
  TenantContext,
  Transaction,
  WorkerHealth,
} from './events/shared.js';

// Scoring — `01-system-architecture/14-scoring-contract.md` (ADR-021)
export type {
  ProducerRef,
  Score,
  ScoreCategory,
  ScoreCategoryDefinition,
  ScoreProducerEngine,
  ScoreStatus,
  ScoreSubject,
  ScoreSubjectKind,
  ScoreVerdict,
  Verdict,
} from './scoring/score.js';
export {
  CONTRACT_VERSION,
  isKnownScoreCategory,
  SCORE_CATEGORIES,
  SCORE_CATEGORY_REGISTRY,
} from './scoring/score.js';

export type {
  EvidenceRef,
  ReasonCodeInstance,
  RecommendedAction,
  ScoreExplanation,
  SectionRef,
  SupportingFact,
} from './scoring/explanation.js';

export type {
  ContributingScore,
  GateEvaluationRequest,
  GateEvaluationResult,
  GatePolicy,
  GateReason,
  ThresholdSnapshot,
} from './scoring/gate.js';
export { composeGateVerdict, REASON_MANDATORY_CATEGORY_MISSING } from './scoring/gate.js';

// AI — the Open Host Service of the AI Capability (`04-context-map.md`).
// One published interface serves every context, which is why it is here and
// not in `packages/ai`: an engine issuing an AIRequest is a feature package,
// and two feature packages may not import each other.
export type { AICapability } from './ai/capability.js';
export { AI_CAPABILITIES, isAICapability } from './ai/capability.js';
export type { AIMessage, AIParameters, AIRequest, AIRequestField, AIRole } from './ai/request.js';
export { AI_REQUEST_FIELDS, AI_ROLES } from './ai/request.js';
export type {
  AIResponse,
  AIResponseField,
  CostEstimate,
  FinishReason,
  TokenUsage,
  Usage,
} from './ai/response.js';
export { AI_RESPONSE_FIELDS, FINISH_REASONS, isFinishReason } from './ai/response.js';
export type { ProviderErrorCode, ProviderErrorOptions } from './ai/errors.js';
export {
  isProviderError,
  isProviderErrorCode,
  isRetryableProviderErrorCode,
  PROVIDER_ERROR_CODES,
  ProviderError,
  RETRYABLE_PROVIDER_ERROR_CODES,
} from './ai/errors.js';
