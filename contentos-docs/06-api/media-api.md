# Media API

> **Status:** v1.0 — complete. Phase 12. **Contracts only.**
> **Bytes never transit this API.** Uploads and downloads go directly between the client and object storage through presigned URLs. The API is the control path; it is never the data path.

## Overview

**Purpose.** Define endpoints for upload, multipart upload, metadata, derived assets, signed URLs, deletion, and restore.

**Every operation delegates to the Storage Platform's sixteen frozen operations** (`12-storage-platform/storage-apis.md`). This document maps a subset of them to HTTP; it defines no storage behaviour.

**Three Phase 10 invariants are visible in every contract below.** Objects are immutable — there is no endpoint that replaces bytes. Internal storage keys are never exposed — `objectId` is the only public identifier. And an object is unreadable until it reaches `available`, so no URL is issued before validation, scanning, and required derivations complete.

## What is never exposed

| Never returned | Why |
|---|---|
| Storage keys, bucket names | Leak the tenant prefix and internal layout |
| Provider identity or endpoint | Migration would become a breaking change |
| Encryption key ids | Key management is delegated entirely |
| **Malware signatures** | Would let an uploader iterate against the scanner |
| Internal transform parameters | `transformId` is opaque |

## Common contract

| Property | Value |
|---|---|
| Base path | `/v1/workspaces/{workspaceId}/media` and `/v1/media/{mediaId}` |
| Authorization | Workspace-tier; `article:*` and `integration:*` per context |
| Rate-limit class | `read` or `write`; upload initiation is `write` |
| Audit | Upload, delete, restore, and URL issuance for exports |

## Media resource

```ts
interface Media {
  readonly id: string;                        // opaque — the ONLY public identifier
  readonly kind: 'image' | 'document' | 'audio' | 'video' | 'other';
  readonly status: MediaStatus;
  readonly contentType: string;               // DETECTED, never the declared value
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly metadata: ExtractedMetadata;       // technical only
  readonly derivatives: readonly Derivative[];
  readonly label: string | null;              // mutable
  readonly createdAt: string;
  readonly deletedAt: string | null;
  readonly purgeEligibleAt: string | null;
}

type MediaStatus =
  | 'pending' | 'uploaded' | 'scanning' | 'processing'
  | 'available' | 'degraded' | 'rejected' | 'quarantined' | 'deleted';
```

**`contentType` is the detected type, never the declared one.** A file claiming `image/png` that is actually HTML is stored and reported as what it is (`16-security/api-security.md`).

**`metadata` carries technical facts only** — dimensions, duration, page count. Never semantic description; alt text is content and belongs to the Writing Engine under ADR-018 (`12-storage-platform/media-processing.md`).

**`degraded` means the original is readable but an optional derivative failed.** It is a serviceable state, not an error — withholding a working image because a WebP variant failed would punish the user for a background failure.

## Upload — simple

| Field | Value |
|---|---|
| **Purpose** | Upload a file under 100 MB |
| **Method · Path** | `POST /v1/workspaces/{workspaceId}/media` |
| **Authorization** | `article:create` or `integration:manage` per context |
| **Idempotency** | **`Idempotency-Key` required** |
| **Rate limit** | `write` |
| **Events** | `MediaUploadInitiated`, then `MediaAvailable` |
| **Audit** | Actor, size, declared type, outcome |

```ts
// request — metadata only; NO file content
{
  filename: string;              // used for extension hinting only, then DISCARDED
  contentType: string;           // declared — advisory, re-detected server-side
  sizeBytes: number;
  resourceRef?: { kind: 'article' | 'project'; id: string };
}

// 201
{
  media: Media;                  // status: 'pending'
  upload: {
    url: string;                 // presigned PUT — 15 minutes
    method: 'PUT';
    headers: Record<string, string>;
    expiresAt: string;
  };
}
```

| Error | Code | Status |
|---|---|---|
| Size above limit | `VALIDATION_SIZE_EXCEEDED` | 413 |
| Declared type not allowed | `VALIDATION_TYPE_UNSUPPORTED` | 415 |
| Storage quota reached | `DOMAIN_QUOTA_EXCEEDED` | 402 |

**The client uploads directly to the returned URL.** Proxying bytes through the API would make every instance a bandwidth bottleneck and require buffering multi-gigabyte payloads (`12-storage-platform/object-storage.md`).

**The filename is used for an extension hint and then discarded.** The stored key is server-constructed, which removes path traversal, null-byte tricks, and double-extension attacks as a category.

**Pre-flight checks run before a byte moves.** A declared size above the limit is rejected at initiation rather than after transferring 4 GB.

**The presigned URL carries content-type and size constraints enforced by the provider**, so an upload slot cannot be used to store something else.

## Upload — multipart

| Field | Value |
|---|---|
| **Purpose** | Upload a file above 100 MB, resumably |
| **Method · Path** | `POST .../media/multipart` · `POST /v1/media/{mediaId}/complete` · `DELETE /v1/media/{mediaId}/multipart` |
| **Authorization** | Same as simple upload |
| **Idempotency** | Initiation requires `Idempotency-Key`; completion is idempotent |
| **Rate limit** | `write` |
| **Events** | `MediaUploadInitiated`, `MediaAvailable` |
| **Audit** | Actor, size, part count |

```ts
// 201 — initiation
{
  media: Media;
  upload: {
    uploadId: string;
    partSizeBytes: 8388608;                     // 8 MiB, fixed
    parts: readonly { partNumber: number; url: string }[];
    expiresAt: string;
  };
}

// POST /media/{id}/complete
{ uploadId: string; parts: readonly { partNumber: number; etag: string }[]; }
```

| Error | Code | Status |
|---|---|---|
| Checksum mismatch on completion | `STORAGE_INTEGRITY_FAILURE` | 422 |
| Missing parts | `MEDIA_INCOMPLETE_UPLOAD` | 409 |
| Upload expired | `MEDIA_UPLOAD_EXPIRED` | 410 |

**Part size is fixed at 8 MiB rather than negotiated.** A variable size complicates resumption, because a resumed upload must use the same part size as the original.

**Uploads are resumable: re-requesting initiation with the same `Idempotency-Key` returns the existing `uploadId` and the parts still outstanding.** The difference between a 4 GB upload failing at 90% and starting over.

**Incomplete uploads expire after 24 hours** and their parts are aborted by a lifecycle rule. Abandoned parts are billed but invisible in a bucket listing, so application-level cleanup alone is insufficient (`12-storage-platform/object-storage.md`).

## Status and metadata

| Field | Value |
|---|---|
| **Purpose** | Retrieve media state and technical metadata |
| **Method · Path** | `GET /v1/media/{mediaId}` · `GET .../media` |
| **Authorization** | `article:read` |
| **Idempotency** | Read-only |
| **Rate limit** | `read` |
| **Events** | None |
| **Audit** | Not recorded |

**Filterable:** `kind`, `status`, `resourceRef`, `createdAfter`, `createdBefore`.
**Sortable:** `createdAt`, `sizeBytes`. Default `-createdAt`.

**Polling `GET /media/{id}` is how a client waits for `available`.** Upload completion returns `uploaded`; scanning and derivation follow asynchronously, typically reaching `available` within 60 seconds for images (`12-storage-platform/blob-lifecycle.md`).

| Error | Code | Status |
|---|---|---|
| In another tenant | `SECURITY_AUTHORIZATION_DENIED` | **404** |
| Quarantined | Returned with `status: 'quarantined'` | 200 |

**A quarantined object is visible to its owner with its status, but never downloadable.** Hiding it entirely would leave the uploader believing their file vanished; the specific threat signature is never disclosed, because that would let an uploader iterate against the scanner (`12-storage-platform/media-processing.md`).

## Update metadata

| Field | Value |
|---|---|
| **Purpose** | Change mutable metadata |
| **Method · Path** | `PATCH /v1/media/{mediaId}` |
| **Authorization** | `article:update` |
| **Idempotency** | Idempotent; `If-Match` required |
| **Rate limit** | `write` |
| **Events** | `MediaMetadataUpdated` |
| **Audit** | Changed fields |

```ts
{ label?: string; resourceRef?: { kind: string; id: string } | null; }
```

| Error | Code | Status |
|---|---|---|
| Attempt to change `contentType`, `sizeBytes`, or `sha256` | `VALIDATION_FIELD_INVALID` | **400** |

**Only mutable metadata is accepted, enforced by the request schema.** System metadata is intrinsic to the bytes and immutable; a schema that accepted it would imply bytes could change (`12-storage-platform/storage-apis.md`).

**Changing `resourceRef` re-keys the object internally via `move`.** `mediaId` is stable, so every existing reference survives — which is precisely why references use the opaque id rather than a path.

## Download URLs

| Field | Value |
|---|---|
| **Purpose** | Obtain a time-limited URL for an object or derivative |
| **Method · Path** | `GET /v1/media/{mediaId}/url` |
| **Authorization** | `article:read`; **`article:export` for originals of exportable kinds** |
| **Idempotency** | Read-only |
| **Rate limit** | `read` |
| **Events** | None |
| **Audit** | **Recorded for exports and documents** |

```http
GET /v1/media/{mediaId}/url?transform=medium&ttlSeconds=900
```

```ts
// 200
{ url: string; expiresAt: string; class: 'public' | 'private'; transformId: string | null; }
```

| Error | Code | Status |
|---|---|---|
| Not `available` | `MEDIA_NOT_READY` | 409 |
| Quarantined or rejected | `MEDIA_NOT_AVAILABLE` | 409 |
| Unknown transform | `NOT_FOUND` | 404 |
| `ttlSeconds` above maximum | `VALIDATION_FIELD_INVALID` | 400 |

**Authorization happens before the URL is generated, always.** Once signed, the URL is a bearer credential that no later check can revoke within its lifetime — which is why lifetimes are short and each URL names one object (`12-storage-platform/cdn.md`).

**`ttlSeconds` is client-requestable within a bound**, defaulting to 900 and capped at 3,600 for private assets. Published article images receive longer TTLs because the content is already public.

**Signed URLs are never logged** by the platform, and clients are advised not to log them either — they grant access for their lifetime to anyone holding them.

**Requesting a URL for a document or export is audited**, because bulk extraction is the insider-threat signal that matters (`16-security/threat-model.md`, T-25).

## Derived assets

| Field | Value |
|---|---|
| **Purpose** | List available variants |
| **Method · Path** | `GET /v1/media/{mediaId}/derivatives` |
| **Authorization** | `article:read` |
| **Idempotency** | Read-only |
| **Rate limit** | `read` |
| **Events** | None |
| **Audit** | Not recorded |

```ts
interface Derivative {
  readonly transformId: string;               // opaque
  readonly name: string;                      // 'thumb' | 'small' | 'medium' | 'large' | 'placeholder'
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly dimensions?: { width: number; height: number };
  readonly status: 'available' | 'pending' | 'failed';
}
```

**`name` is the stable client-facing handle; `transformId` is opaque.** A client requests `transform=medium` and never constructs a transform id — which is what lets the platform bump a transform's algorithm version and produce new derivations without any client change (`12-storage-platform/media-processing.md`).

**`status: 'failed'` is visible.** A missing optional variant is surfaced so a client can fall back to another size rather than rendering a broken image.

## Deletion and restore

| Field | Value |
|---|---|
| **Purpose** | Soft-delete media and reverse it within the grace period |
| **Method · Path** | `DELETE /v1/media/{mediaId}` · `POST /v1/media/{mediaId}/actions/restore` |
| **Authorization** | `article:delete` · `article:update` |
| **Idempotency** | Both idempotent |
| **Rate limit** | `write` |
| **Events** | `MediaDeleted` · `MediaRestored` |
| **Audit** | Actor and reason |

```ts
// DELETE → 204
// restore → 200 { media: Media }
```

| Error | Code | Status |
|---|---|---|
| **Still referenced** | `MEDIA_IN_USE` | **409** |
| Grace period elapsed | `MEDIA_PURGED` | 410 |
| Legal hold | `COMPLIANCE_LEGAL_HOLD` | 409 |

**Deletion is refused while the object is referenced.** A derived image used by six article revisions is not deletable because one revision was removed; the response names the reference count so the client can explain why (`12-storage-platform/retention.md`).

**Soft delete has a 30-day grace period**, surfaced as `purgeEligibleAt`. After it, hard deletion proceeds and restore returns `410` — the object is gone, not merely hidden.

**Deleting media invalidates its CDN entries immediately**, not at purge. An object hidden in the database but still cached at an edge is still being served (`12-storage-platform/cdn.md`).

**Deletion is idempotent; restore after purge is not possible.** The distinction is honest: `204` for a delete that already happened, `410` for a restore that cannot.

## Business rules

1. **Bytes never transit the API** — presigned direct transfer.
2. **`mediaId` is the only public identifier**; keys and buckets are never exposed.
3. **Filenames are discarded**; keys are server-constructed.
4. **`contentType` is detected, never declared.**
5. **Objects are immutable** — no endpoint replaces bytes.
6. **Only mutable metadata is accepted in `PATCH`.**
7. **No URL is issued before `available`.**
8. **Authorization precedes URL generation, always.**
9. **`ttlSeconds` is bounded**; signed URLs are never logged.
10. **Quarantined objects are visible, never downloadable**; signatures are never disclosed.
11. **Part size is fixed at 8 MiB; uploads are resumable.**
12. **Incomplete uploads expire at 24 hours.**
13. **Deletion is refused while referenced**, with the count returned.
14. **Deletion invalidates CDN entries immediately.**
15. **Restore is available for 30 days, then `410`.**
16. **`transformId` is opaque; clients request variants by name.**
17. **Document and export URL issuance is audited.**

## Events emitted

| Event | Trigger |
|---|---|
| `MediaUploadInitiated` | Upload accepted |
| `MediaAvailable` | Scanning and required derivations complete |
| `MediaQuarantined` | Threat detected |
| `MediaMetadataUpdated` | Mutable metadata change |
| `MediaDeleted` · `MediaRestored` | Lifecycle |

**`MediaAvailable` is the event the Writing Engine consumes to bind `MediaSpec.asset_ref`** (ADR-018). It must be an event rather than a synchronous callback, because the two components must not be coupled in time (`12-storage-platform/blob-lifecycle.md`).

**Payloads carry identifiers, sizes, and content types — never bytes, storage keys, or signed URLs** (`13-event-platform/event-registry.md`).

## Audit implications

| Action | Recorded |
|---|---|
| Upload | Actor, size, declared and detected type, outcome |
| **Quarantine** | Detection category — **never the signature** |
| Delete, restore | Actor, reason, reference count |
| **URL issuance for documents and exports** | Actor, media id, TTL |
| URL issuance for images | Not recorded — too high volume |

**Image URL issuance is deliberately not audited.** A page render signs dozens of URLs; auditing each would produce volume that buries the export records that matter, and image delivery is not a privileged operation (`16-security/audit.md`).

## Cross references

- `12-storage-platform/storage-apis.md` — **the sixteen frozen operations this maps to**
- `12-storage-platform/blob-lifecycle.md` — states and the readability gate
- `12-storage-platform/media-processing.md` — derivations, `transformId`, scanning
- `12-storage-platform/object-storage.md` — immutability, multipart, keys
- `12-storage-platform/cdn.md` — signed URLs, invalidation
- `12-storage-platform/retention.md` — reference counting, grace period
- `16-security/api-security.md` — magic-byte detection, upload validation
- `16-security/tenant-isolation.md` — presigned URL policy, key confidentiality
- `16-security/threat-model.md` — T-09 storage compromise, T-25 exfiltration
- `content-api.md` — articles referencing media
- `api-principles.md` — actions, `If-Match`, idempotency
- `01-system-architecture/13-adr-log.md` — **ADR-018 media split**
