/**
 * The worker process's event registry — a COMPOSITION ROOT.
 *
 * `workers/host` is the CONSUMER process, and the difference from the API root
 * is the one that matters: here a declared consumer group MUST have a handler.
 *
 * Without that check the failure is silent and slow. A group declared in the
 * registry has a Redis consumer group created for it; events accumulate
 * against an offset nobody advances; the stream grows; and the first symptom
 * is a lag alert hours later, or a customer noticing something never happened.
 * Requiring the handler at startup turns that into a failed deploy.
 *
 * The relay is deliberately NOT affected. It drains the outbox for the whole
 * platform and registers no handlers, so it composes with an empty handler set
 * exactly as before.
 */

import {
  composeEventRegistry,
  type ComposedRegistry,
  type RegisteredHandler,
} from '@contentos/events';
import { PLATFORM_REGISTRY_CONTRIBUTION } from '@contentos/platform';

export const WORKER_REGISTRY_CONTRIBUTIONS = [PLATFORM_REGISTRY_CONTRIBUTION];

/**
 * Build the registry for a worker running `handlers`, or throw and refuse to
 * start.
 *
 * `handlers` is what this process was configured to run — one binary hosts any
 * set of registered handlers, selected by configuration
 * (`13-event-platform/workers.md`). Validation is two-way: every declared
 * group needs a handler, and every handler needs a declaration whose tenant
 * scope it agrees with (ADR-029).
 *
 * Passing none is valid and is what the relay-only deployment does.
 */
export function createWorkerEventRegistry(
  handlers: readonly RegisteredHandler[] = [],
): ComposedRegistry {
  return composeEventRegistry({
    contributions: WORKER_REGISTRY_CONTRIBUTIONS,
    handlers,
    // A consumer process is exactly where an unhandled group is a defect.
    requireHandlers: true,
  });
}
