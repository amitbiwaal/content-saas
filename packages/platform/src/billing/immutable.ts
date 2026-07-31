/**
 * Deep freezing, once for the Commerce module.
 *
 * The credits modules each carry their own copy, which is the convention there.
 * This module is new, so its four files share one — an object that came back
 * mutable from a plan lookup is a customer's entitlements edited in place.
 */

export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}
