/**
 * The idempotency protocol, as the router runs it.
 *
 *   begin  → proceed | replay | refuse
 *   ...the controller runs, once...
 *   settle → complete (store the response) | release (free the claim)
 *
 * ── Replay returns the ORIGINAL response, status included ───────────────────
 * `api-principles.md`: "Returning the original response — including its status
 * — is what makes retries safe. A client retrying POST /runs after a network
 * timeout receives the first run's result, not a second run and not a 409."
 * So a replayed 200 is a 200 and a replayed 422 is a 422; only the two
 * idempotency headers are added.
 *
 * ── Two different conflicts ─────────────────────────────────────────────────
 * A key reused with a DIFFERENT request is a client bug: the same key means the
 * same work, and returning the first request's response would hand back an
 * unrelated resource. A key reused while the first is STILL RUNNING is not a
 * bug at all — it is the retry this mechanism exists for, arriving early.
 *
 * Both are 409, and they are told apart by `code`, because this platform's own
 * rule is that clients branch on the code and never on the status text alone.
 * The second carries `Retry-After`; the first never could, since waiting will
 * not fix a mismatched payload.
 *
 * ── DIVERGENCE from `06-api/api-principles.md`, flagged not buried ──────────
 * That document, and `16-security/api-security.md`, both specify **422** for a
 * key reused with a different body — four passages and two business rules. This
 * increment specifies 409, explicitly and by number, so 409 is what is
 * implemented; the divergence is recorded here, in the deliverable, and in a
 * conformance assertion so it cannot be forgotten. Changing it back is one line
 * in `CONFLICT_STATUS`.
 *
 * ── Pending refuses rather than waits ───────────────────────────────────────
 * The increment permits either. Waiting holds a connection open for the whole
 * of the in-flight request, and the in-flight request here is a model call —
 * the slowest thing the platform does. A pool of waiting duplicates is how one
 * client's retry storm exhausts the connections every other client needs.
 * Refusing with `Retry-After` costs the client one round trip and costs the
 * server nothing.
 */

import type { Principal } from '@contentos/security';

import { errorFor, type ApiResponse } from '../ai/http.js';
import { fingerprintOf } from './fingerprint.js';
import {
  idempotencyKeyFor,
  IdempotencyStoreUnavailableError,
  type IdempotencyStore,
  type StoredResponse,
} from './store.js';

/** See the DIVERGENCE note above. */
export const CONFLICT_STATUS = 409;

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
export const IDEMPOTENT_REPLAY_HEADER = 'idempotent-replay';

/**
 * How long a client should wait before retrying a request whose twin is in
 * flight. One second: the duplicate arrived because the first is slow, and a
 * shorter value is a hot loop.
 */
export const PENDING_RETRY_AFTER_SECONDS = 1;

export type IdempotencyOutcome =
  /** Not an idempotent request, or no key supplied. Nothing to do. */
  | { readonly outcome: 'skipped' }
  /** The claim is ours. The controller runs exactly once. */
  | {
      readonly outcome: 'proceed';
      readonly storageKey: string;
      readonly fingerprint: string;
      readonly clientKey: string;
    }
  | { readonly outcome: 'replay'; readonly response: ApiResponse }
  | { readonly outcome: 'refused'; readonly response: ApiResponse };

interface IdempotencyGuardOptions {
  readonly store: IdempotencyStore;
}

export interface BeginInput {
  readonly principal: Principal;
  readonly method: string;
  /** The ROUTE pattern, so two ids on one endpoint share a scope correctly. */
  readonly endpoint: string;
  readonly body: unknown;
  /** The client's `Idempotency-Key`, already read from the header. */
  readonly clientKey: string | null;
  readonly requestId: string;
}

export interface IdempotencyGuard {
  begin(input: BeginInput): Promise<IdempotencyOutcome>;
  /** Store the response for replay. Only ever called for a claim we hold. */
  complete(storageKey: string, fingerprint: string, response: ApiResponse): Promise<void>;
  /** Free a claim that produced nothing replayable. */
  release(storageKey: string): Promise<void>;
}

/** Replay adds the two idempotency headers and changes nothing else. */
function replayOf(stored: StoredResponse, clientKey: string): ApiResponse {
  return Object.freeze({
    status: stored.status,
    headers: Object.freeze({
      ...stored.headers,
      [IDEMPOTENCY_KEY_HEADER]: clientKey,
      [IDEMPOTENT_REPLAY_HEADER]: 'true',
    }),
    body: stored.body,
  });
}

export function createIdempotencyGuard(options: IdempotencyGuardOptions): IdempotencyGuard {
  return {
    async begin(input: BeginInput): Promise<IdempotencyOutcome> {
      // Only requests that create or charge. `api-principles.md` requires the
      // key on "every non-idempotent POST"; a GET is already repeatable and
      // storing its response here would be a second, unmanaged cache.
      if (input.method.toUpperCase() !== 'POST' || input.clientKey === null) {
        return Object.freeze({ outcome: 'skipped' as const });
      }

      const fingerprint = fingerprintOf({
        principal: input.principal,
        endpoint: input.endpoint,
        method: input.method,
        body: input.body,
      });
      const storageKey = idempotencyKeyFor(input.principal.workspaceId, input.clientKey);

      let begun;
      try {
        begun = await options.store.begin(storageKey, fingerprint);
      } catch (failure) {
        if (!(failure instanceof IdempotencyStoreUnavailableError)) throw failure;
        // Refuse rather than proceed unguarded. Executing without the claim is
        // how a retry storm during a Redis blip becomes a duplicate charge,
        // and this endpoint's duplicates cost real money.
        return Object.freeze({
          outcome: 'refused' as const,
          response: errorFor(503, 'service_unavailable', input.requestId, undefined, {
            'retry-after': String(PENDING_RETRY_AFTER_SECONDS),
          }),
        });
      }

      if (begun.outcome === 'claimed') {
        return Object.freeze({
          outcome: 'proceed' as const,
          storageKey,
          fingerprint,
          clientKey: input.clientKey,
        });
      }

      const { record } = begun;
      if (record.fingerprint !== fingerprint) {
        // The client bug. Never says WHAT differed — the stored fingerprint is
        // internal, and echoing the first request's shape would disclose it to
        // whoever guessed the key.
        return Object.freeze({
          outcome: 'refused' as const,
          response: errorFor(CONFLICT_STATUS, 'idempotency_conflict', input.requestId, undefined, {
            [IDEMPOTENCY_KEY_HEADER]: input.clientKey,
          }),
        });
      }

      if (record.state === 'completed') {
        return Object.freeze({
          outcome: 'replay' as const,
          response: replayOf(record.response, input.clientKey),
        });
      }

      return Object.freeze({
        outcome: 'refused' as const,
        response: errorFor(CONFLICT_STATUS, 'idempotency_in_progress', input.requestId, undefined, {
          'retry-after': String(PENDING_RETRY_AFTER_SECONDS),
          [IDEMPOTENCY_KEY_HEADER]: input.clientKey,
        }),
      });
    },

    async complete(storageKey: string, fingerprint: string, response: ApiResponse): Promise<void> {
      try {
        await options.store.complete(storageKey, fingerprint, {
          status: response.status,
          headers: response.headers,
          body: response.body,
        });
      } catch (failure) {
        // The response is already computed and about to be sent. Failing the
        // request because the store is down would discard work the caller has
        // paid for; the cost is that a retry re-executes, which is the state
        // the platform was in before idempotency existed.
        if (!(failure instanceof IdempotencyStoreUnavailableError)) throw failure;
      }
    },

    async release(storageKey: string): Promise<void> {
      try {
        await options.store.release(storageKey);
      } catch (failure) {
        // A claim left behind expires on its own within the window. Worth
        // trying, never worth failing a response over.
        if (!(failure instanceof IdempotencyStoreUnavailableError)) throw failure;
      }
    },
  };
}

/** Exported for the router: a successful response carries its key back. */
export function withIdempotencyKey(response: ApiResponse, clientKey: string): ApiResponse {
  return Object.freeze({
    ...response,
    headers: Object.freeze({ ...response.headers, [IDEMPOTENCY_KEY_HEADER]: clientKey }),
  });
}
