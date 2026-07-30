/**
 * The API process's event registry — a COMPOSITION ROOT.
 *
 * `services/api` is a PRODUCER-ONLY process. It publishes through the outbox
 * and runs no consumers, so it registers no handlers and does not require
 * them: demanding a handler here for every declared consumer group would make
 * every new worker-side group break the API's startup, which is the wrong
 * process to fail.
 *
 * It still validates the full declaration set, and that is deliberate. A
 * producer that starts with an invalid registry is a producer that publishes
 * an event type nothing agreed to — and `publish` validates against the
 * registry inside the caller's transaction, so a missing declaration surfaces
 * as a rolled-back business operation rather than as a startup failure. Better
 * to refuse to start.
 */

import { composeEventRegistry, type ComposedRegistry } from '@contentos/events';
import { PLATFORM_REGISTRY_CONTRIBUTION } from '@contentos/platform';

/**
 * Every package that can publish from this process.
 *
 * Adding a producing package means adding its contribution here — one line,
 * in one place, checked at startup.
 */
export const API_REGISTRY_CONTRIBUTIONS = [PLATFORM_REGISTRY_CONTRIBUTION];

/**
 * Build the registry, or throw and refuse to start.
 *
 * Called once, at startup. Nothing else in the process constructs a registry:
 * a second one could disagree with this one, and the disagreement would only
 * show as an event that publishes on one path and not another.
 */
export function createApiEventRegistry(): ComposedRegistry {
  return composeEventRegistry({
    contributions: API_REGISTRY_CONTRIBUTIONS,
    requireHandlers: false,
  });
}
