/**
 * Stripe's wire shapes — the JSON, not the SDK.
 *
 * ── Why these are declared rather than imported ────────────────────────────
 * A webhook is a JSON body off an HTTP request; the SDK's types describe the
 * same JSON with none of the extra reach. This increment makes no live call —
 * "Create provider interfaces only", with REST APIs and database
 * implementation out of scope — so an SDK dependency here would be one with no
 * call site, and its types would be a heavier way to say the same thing.
 *
 * The eslint config already reserves `packages/platform/src/billing/**` as the
 * only place `stripe` may ever be imported. When live calls land, the SDK has
 * exactly one legal home and it is this directory.
 *
 * ── There are no wire INTERFACES here, deliberately ───────────────────────
 * A webhook body is untrusted: Stripe adds fields, versions its API, and
 * anybody can POST to the endpoint. Declaring `interface StripeInvoiceWire`
 * would suggest a contract that holds, when in fact every field has to be
 * proven at the point it is read. So the shapes are described here in prose and
 * the readers below take `unknown` — which is what they actually receive.
 *
 * The shapes read, and the fields taken from each:
 *   - event envelope        `id`, `type`, `created`, `data.object`
 *   - checkout.session      `id`, `customer`, `subscription`, `url`,
 *                           `expires_at`, `metadata`
 *   - subscription          `id`, `customer`, `status`, `cancel_at_period_end`,
 *                           `current_period_start`, `current_period_end`,
 *                           `metadata`
 *   - invoice               `id`, `customer`, `subscription`, `metadata`
 *   - customer              `id`, `metadata`
 *   - billing_portal.session `id`, `url`
 *
 * ── NOTHING IN THIS FILE LEAVES THE ADAPTER ───────────────────────────────
 * Not one of these types appears on `PaymentProvider`, on a repository port,
 * or in the barrel. `mapping.ts` consumes them and returns domain models. That
 * is what "never expose raw Stripe SDK objects outside the adapter" means when
 * the raw objects are JSON.
 */

/**
 * The metadata keys we set when we create an object, and read back on its
 * events.
 *
 * `stripe.md` relies on webhooks as the source of truth rather than polling, so
 * an event has to carry enough to be attributed without a second API call.
 * These are OUR keys in THEIR namespace — a customer created in Stripe's
 * dashboard carries neither, and is attributed to nothing rather than guessed.
 */
export const METADATA_ORGANIZATION_ID = 'contentos_organization_id';
export const METADATA_SUBSCRIPTION_ID = 'contentos_subscription_id';

/** A non-empty string, or null. The only way anything here is read. */
export function readString(source: unknown, key: string): string | null {
  if (typeof source !== 'object' || source === null) return null;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * A Stripe id that may arrive expanded.
 *
 * Stripe sends `"customer": "cus_123"` normally and
 * `"customer": { "id": "cus_123", … }` when the field is expanded. Reading only
 * the string form would silently drop the customer on an expanded payload and
 * attribute the event to nobody.
 */
export function readRef(source: unknown, key: string): string | null {
  if (typeof source !== 'object' || source === null) return null;
  const value = (source as Record<string, unknown>)[key];
  if (typeof value === 'string') return value.trim() === '' ? null : value;
  return readString(value, 'id');
}

/** A finite integer, or null. Stripe timestamps are Unix seconds. */
export function readInteger(source: unknown, key: string): number | null {
  if (typeof source !== 'object' || source === null) return null;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

export function readBoolean(source: unknown, key: string): boolean | null {
  if (typeof source !== 'object' || source === null) return null;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'boolean' ? value : null;
}

/** One of our metadata keys, from an object's `metadata` map. */
export function readMetadata(source: unknown, key: string): string | null {
  if (typeof source !== 'object' || source === null) return null;
  return readString((source as Record<string, unknown>)['metadata'], key);
}

/**
 * Unix seconds to an ISO-8601 UTC instant.
 *
 * Returns null rather than an epoch date for a missing or absurd value: an
 * event stamped 1970 would be silently placed in a billing period nobody has.
 */
export function toInstant(seconds: number | null): string | null {
  if (seconds === null || seconds <= 0) return null;
  const millis = seconds * 1000;
  if (!Number.isSafeInteger(millis)) return null;
  return new Date(millis).toISOString();
}
