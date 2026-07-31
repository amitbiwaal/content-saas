/**
 * Version negotiation, and the headers that announce a deprecation.
 *
 * ── Negotiation runs BEFORE authentication, and that is deliberate ──────────
 * S3.3 put routing behind authentication so an unauthenticated caller learns
 * nothing about the API's shape. Versions are different: the supported set is
 * published in the OpenAPI document, so refusing an unsupported one discloses
 * nothing that is not already public. Checking it first also means a client
 * pinned to a retired version gets the 410 that tells it to migrate, rather
 * than a 401 that sends it looking at its credentials.
 *
 * ── The headers are the only channel that reaches an old integration ────────
 * `api-versioning.md`: "Deprecation is announced in-band on every response,
 * not only in a changelog. The header is the only channel that reaches a
 * client integrated two years ago. Nobody reads the changelog for an
 * integration that is working."
 *
 * So `API-Version` goes on EVERY response, and the deprecation trio goes on
 * every response of a deprecated version — including its error responses,
 * because a client whose calls are failing is exactly the one about to
 * investigate.
 */

import type { ApiVersion, VersionRegistry } from './registry.js';

/** Always present, so a client can log which contract answered it. */
export const API_VERSION_HEADER = 'api-version';

/**
 * The RFC 8594 / RFC 7231 trio, as `api-versioning.md` shows them:
 *
 *   Deprecation: Sun, 01 Mar 2026 00:00:00 GMT
 *   Sunset: Tue, 01 Sep 2026 00:00:00 GMT
 *   Link: <https://docs.contentos.ai/api/v2/migration>; rel="deprecation"
 */
export const DEPRECATION_HEADER = 'deprecation';
export const SUNSET_HEADER = 'sunset';
export const LINK_HEADER = 'link';

export type VersionNegotiation =
  | {
      readonly outcome: 'serve';
      readonly version: ApiVersion;
      readonly headers: Readonly<Record<string, string>>;
    }
  | {
      readonly outcome: 'retired';
      readonly version: ApiVersion;
      readonly headers: Readonly<Record<string, string>>;
    }
  | {
      readonly outcome: 'unsupported';
      /** What the caller asked for. Never echoed into a response body. */
      readonly requested: string | null;
      readonly headers: Readonly<Record<string, string>>;
    };

/**
 * The version segment of a path.
 *
 * The FIRST segment and only the first: `/v1/ai/execute` is v1, and a `v2`
 * appearing later in a path is a resource name, not a version.
 */
export function versionFromPath(path: string): string | null {
  const first = path
    .split('?')[0]
    ?.split('/')
    .filter((segment) => segment !== '')[0];
  return first === undefined || first === '' ? null : first;
}

/** HTTP-date, which is what both headers are specified in. */
function httpDate(iso: string): string {
  return new Date(iso).toUTCString();
}

/**
 * The headers a version contributes.
 *
 * A deprecated version carries the whole schedule; the registry has already
 * refused to hold one that does not, so there is no partial case to handle.
 */
export function versionHeaders(version: ApiVersion): Readonly<Record<string, string>> {
  const headers: Record<string, string> = { [API_VERSION_HEADER]: version.version };

  if (version.status === 'deprecated' || version.status === 'sunset') {
    if (version.deprecatedAt !== undefined) {
      headers[DEPRECATION_HEADER] = httpDate(version.deprecatedAt);
    }
    if (version.sunsetAt !== undefined) headers[SUNSET_HEADER] = httpDate(version.sunsetAt);
    if (version.migrationGuide !== undefined) {
      headers[LINK_HEADER] = `<${version.migrationGuide}>; rel="deprecation"`;
    }
  }

  return Object.freeze(headers);
}

/**
 * Which version a path asks for, and whether it may be served.
 *
 * An unknown version is refused rather than defaulted — see the registry's
 * header for why. The response still carries `API-Version` naming the CURRENT
 * version, which is the one actionable thing a caller on a bad version needs.
 */
export function negotiateVersion(registry: VersionRegistry, path: string): VersionNegotiation {
  const requested = versionFromPath(path);
  const version = requested === null ? null : registry.find(requested);

  if (version === null) {
    return Object.freeze({
      outcome: 'unsupported' as const,
      requested,
      headers: Object.freeze({ [API_VERSION_HEADER]: registry.current.version }),
    });
  }

  const headers = versionHeaders(version);
  return version.status === 'sunset'
    ? Object.freeze({ outcome: 'retired' as const, version, headers })
    : Object.freeze({ outcome: 'serve' as const, version, headers });
}
