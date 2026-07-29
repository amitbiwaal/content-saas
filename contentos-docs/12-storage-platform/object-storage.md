# Object Storage

> **Status:** v1.0 — complete. New in Phase 10.
> **Objects are immutable; metadata evolves.** That split determines where every piece of state lives: bytes and their intrinsic properties go in the object store, everything mutable goes in PostgreSQL.

## Overview

**Business purpose.** Media, exports, and source documents are the platform's largest and most durable artifacts. They must be storable at scale, retrievable in milliseconds through a CDN, verifiable against corruption, and deletable with a guarantee that satisfies a regulator.

**Technical purpose.** Specify bucket topology, namespace and key construction, object identity, versioning semantics, multipart and streaming transfer, and the integrity model.

**The design tension.** Object stores are optimized for immutable blobs and are poor at mutable metadata — changing an S3 object's metadata requires rewriting the object. PostgreSQL is the opposite. The platform therefore splits state along exactly that seam rather than fighting either system.

## Responsibilities

- Bucket topology and namespace design.
- Object identity and key construction.
- Versioning semantics.
- Multipart upload and streaming transfer.
- Integrity: checksums, verification, corruption detection.
- Content type determination.
- System versus mutable metadata placement.

## Non-responsibilities

| Not owned | Owner |
|---|---|
| Provider API differences | `storage-abstraction.md` |
| Lifecycle state transitions | `blob-lifecycle.md` |
| Derivations and thumbnails | `media-processing.md` |
| Delivery and caching | `cdn.md` |
| Retention policy and GC | `retention.md` |
| Encryption and keys | `16-security/encryption.md` |
| Access decisions | `16-security/authorization.md` |

## Bucket topology

**Four buckets, partitioned by lifecycle class — never by tenant.**

| Bucket | Contents | Versioning | Public path |
|---|---|---|---|
| `contentos-media` | Uploaded and generated media, derivations | Enabled | CDN |
| `contentos-exports` | Generated export bundles | Disabled | Presigned only |
| `contentos-backups` | Database and audit archives | Enabled + Object Lock | **None** |
| `contentos-quarantine` | Malware detections, rejected uploads | Enabled | **None** |

**Bucket-per-tenant is rejected outright.** S3 and R2 impose account-level bucket limits in the low thousands; a platform targeting more customers than that would hit a hard ceiling with no migration path. Tenant separation is achieved by key prefix, enforced by server-side key construction (`16-security/tenant-isolation.md`).

**Partitioning by lifecycle class is what makes bucket-level policy useful.** Backups need Object Lock and seven-year retention; exports need aggressive expiry; media needs CDN access. Those are incompatible bucket configurations, and one bucket holding all three would force every policy to the most permissive setting.

**`contentos-backups` has no read path from application code.** It is written by the backup process and read only during a restore, which is break-glass and audited (`backups.md`). An application role that could read backups could read every tenant's data, since RLS does not apply to a backup object.

**`contentos-quarantine` is write-only from the scanning path** and readable only by security operators. Objects land there and stay as evidence.

## Namespaces and keys

```
{tenantId}/{resourceType}/{resourceId}/{objectId}.{ext}
```

| Segment | Purpose |
|---|---|
| `tenantId` | **Isolation prefix.** Enables per-tenant enumeration, policy, and erasure |
| `resourceType` | `article`, `brief`, `upload`, `export`, `source-document` |
| `resourceId` | The owning domain entity |
| `objectId` | UUIDv7 — globally unique, time-ordered |
| `ext` | Derived from detected content type, never from the client |

**Keys are constructed server-side from validated components.** No segment is ever concatenated from client input. A client-supplied path fragment permits traversal into another tenant's prefix — the single most direct isolation failure available in an object store.

**UUIDv7 as the final segment gives time-ordered keys within a prefix**, which makes listing by recency an index-order scan rather than a full prefix scan followed by a sort.

**Key structure is never exposed.** Callers receive `objectId` and, when they need bytes, a presigned URL. Returning a key would leak the tenant id and internal layout, and would freeze a structure that must stay changeable — re-tiering or re-sharding would break every stored reference.

**The id-to-key mapping lives in `media_assets`** with `UNIQUE (tenant_id, object_key)` (`03-database/tables.md`). The unique constraint makes key collision impossible at the database level rather than relying on UUID uniqueness alone.

## Object identity and immutability

**An object key is written exactly once.** There is no overwrite path, no update, and no `PUT` to an existing key.

| Operation | Result |
|---|---|
| "Update" an object | New `objectId`, new key; the old object is unchanged |
| Replace a resource's media | New object; `media_assets` points to the new id |
| Transform an object | New derived object referencing the source |

**Immutability is what makes everything downstream simple.** CDN entries can carry year-long TTLs because a URL's content never changes. Checksums recorded at write remain valid forever. Concurrent readers need no coordination. A restore is byte-identical by definition.

**The alternative is worse than it looks.** Mutable objects require CDN invalidation on every write, a stale edge serves content whose checksum no longer matches, and a reader mid-download receives a mix of two versions — a corruption that no error surfaces.

**Immutability is enforced by the driver**, which issues conditional writes (`If-None-Match: *`) so a write to an existing key fails at the provider rather than silently succeeding. Relying on the application never to reuse a key would eventually fail during a retry.

## Versioning

**Provider versioning is enabled as a safety net, not as the versioning model.**

| Concern | Mechanism |
|---|---|
| Logical versioning | **New object, new id** — the platform's model |
| Accidental deletion | Provider versioning; delete markers are recoverable |
| Ransomware or bulk delete | Versioning plus Object Lock on backups |
| Lifecycle of old versions | Noncurrent versions expire after 30 days |

**The two are not redundant.** The platform's model gives every logical version a distinct, addressable id that domain metadata can reference. Provider versioning protects against operator and code errors that delete or overwrite despite the conditional-write guard. One is a feature; the other is a backstop.

**Noncurrent versions expire after 30 days**, matching the soft-delete grace period in `retention.md`. Retaining them indefinitely would make cryptographic erasure incomplete and storage cost unbounded.

## Multipart upload

| Threshold | Value |
|---|---|
| Multipart above | 100 MB |
| Part size | 8 MB (last part may be smaller) |
| Maximum parts | 10,000 |
| Maximum object | 5 TB (provider limit) |
| Concurrency | 4 parts in flight |
| **Incomplete upload cleanup** | **Abort after 24 h — lifecycle rule** |

**Aborting incomplete multipart uploads is mandatory and easy to forget.** Parts from an abandoned upload are billed but invisible: they do not appear in a bucket listing, do not count as objects, and accumulate indefinitely. A bucket lifecycle rule aborting them after 24 hours is the only reliable cleanup — application-level cleanup fails exactly when the client crashed.

**Part size is fixed at 8 MB rather than computed.** A variable part size derived from object size complicates resumption, since a resumed upload must use the same part size as the original. Fixed parts make resume a matter of listing completed parts and continuing.

**Upload is resumable.** The upload id and completed part list are recorded, so a client reconnecting after a failure re-uploads only missing parts — the difference between a 4 GB video upload failing at 90% and starting over versus finishing.

```mermaid
sequenceDiagram
    participant C as Client
    participant API as Storage API
    participant D as Driver
    participant S as Object store

    C->>API: initiateUpload(size, contentType)
    API->>D: createMultipartUpload
    D->>S: initiate
    S-->>API: uploadId
    API-->>C: uploadId + presigned part URLs
    loop each part
        C->>S: PUT part (direct — bytes never transit the API)
        S-->>C: ETag
    end
    C->>API: completeUpload(uploadId, parts[])
    API->>D: completeMultipartUpload
    API->>API: verify checksum; write media_assets; publish via outbox
```

**Bytes go directly from client to object store, never through the API.** Proxying uploads would make every API instance a bandwidth bottleneck and would require buffering multi-gigabyte payloads. Presigned part URLs keep the API on the control path only.

## Streaming

**Objects are never fully buffered in memory, at any layer.**

| Path | Mechanism |
|---|---|
| Upload | Streamed to the store; checksum computed incrementally |
| Download | Presigned URL — the client fetches directly |
| Processing | Streamed through the transform; bounded buffer |
| Backup | Streamed and encrypted in chunks |

**A single 5 GB object buffered in memory exhausts a worker.** Streaming with a bounded buffer means memory use is a function of concurrency, not object size — the property that lets one worker process a 4 GB video and a 40 KB image with the same footprint.

**Range requests are supported** for partial reads, which is what makes video seeking and PDF page extraction possible without transferring the whole object.

## Integrity

**Every object carries a SHA-256 checksum recorded at write.**

```ts
interface ObjectIntegrity {
  readonly sha256: string;          // platform-computed, authoritative
  readonly crc32c: string;          // provider-computed, transfer verification
  readonly sizeBytes: number;
  readonly verifiedAt: Date | null;
}
```

| Layer | Purpose |
|---|---|
| **SHA-256** | Content identity and long-term integrity; computed by the platform |
| **CRC32C** | Transfer corruption; computed by the provider per part |
| Size | Cheap first-order mismatch detection |

**Two checksums serve different failure modes.** CRC32C catches corruption in transit and is what the provider verifies per part — fast, and it fails the upload immediately. SHA-256 catches corruption at rest, silent bit rot, and substitution; it is cryptographic, so a modified object cannot produce a matching digest.

**The checksum is computed during the stream, not afterwards.** Reading the object back to hash it doubles transfer cost and, for a multipart upload, would require downloading 5 GB to verify what was just written.

**Verification runs on a rolling schedule** — a bounded sample of objects re-read and compared against their recorded SHA-256. Corruption detected this way is an alert, and the recovery path is a restore from backup (`disaster-recovery.md`).

**A checksum mismatch on read fails the read.** Serving an object whose bytes do not match its recorded digest would propagate corruption downstream, where it is far harder to diagnose than at the source.

## Content types

**The content type is determined by magic-byte inspection, never by the client's declaration.**

```ts
interface ContentTypeResolution {
  readonly declared: string | null;    // client-supplied — advisory only
  readonly detected: string;            // magic bytes — authoritative
  readonly extension: string;           // derived from detected
  readonly matched: boolean;            // declared === detected
}
```

**A mismatch is recorded and, for executable-adjacent types, rejects the upload.** A file declared `image/png` that is actually HTML is either a broken client or an attempt to store an XSS payload behind a trusted content type (`16-security/api-security.md`).

**The stored `Content-Type` is the detected value**, and objects are served with `X-Content-Type-Options: nosniff` so a browser cannot reinterpret them (`cdn.md`).

**The extension is derived from the detected type**, so a key never carries a client-chosen extension — removing double-extension attacks as a category.

## Metadata placement

**This is the decision that follows directly from immutability.**

| Metadata | Location | Why |
|---|---|---|
| **Checksum, size, content type, created-at** | Object store (system metadata) | Intrinsic to the bytes; never changes |
| **Tenant, resource linkage, status, refcount, tags, processing state** | **PostgreSQL — `media_assets`** | Mutable |
| Transform manifest | PostgreSQL — `transforms JSONB` | Grows as derivations are produced |

**Mutable metadata cannot live in object metadata**, because changing an S3 object's metadata requires copying the object onto itself — a full rewrite. For a 4 GB video, updating a status flag would rewrite 4 GB. Storing mutable state in PostgreSQL makes it a row update.

**This also keeps the object store queryable-free.** Object stores have no query capability beyond prefix listing; finding "all objects for tenant X awaiting processing" is a database query, not a bucket scan.

**System metadata is duplicated into `media_assets` at write time** so that reads, listings, and integrity checks need no object-store round trip. The object store remains authoritative for bytes; the database is authoritative for everything else and is reconciled by the verification sweep.

## Business rules

1. **Objects are immutable**; a key is written once, enforced by conditional write.
2. **Metadata may evolve**, and mutable metadata lives in PostgreSQL.
3. **Internal keys and bucket names are never exposed** to callers.
4. **Keys are server-constructed** from validated components; client input is never concatenated.
5. **Four buckets partitioned by lifecycle class**; never bucket-per-tenant.
6. **`contentos-backups` has no application read path.**
7. **Provider versioning is enabled as a backstop**, not the versioning model.
8. **Noncurrent versions expire after 30 days.**
9. **Incomplete multipart uploads are aborted after 24 h** by lifecycle rule.
10. **Bytes never transit the API** — presigned direct transfer.
11. **Objects are never fully buffered**; all transfer is streamed.
12. **Every object has a SHA-256** computed during the stream.
13. **A checksum mismatch on read fails the read.**
14. **Content type is detected, never declared**; the extension is derived.
15. **Uploads are resumable** via recorded upload id and part list.

## Interfaces

```ts
interface ObjectWriter {
  initiate(ctx: TenantContext, req: UploadRequest): Promise<UploadTicket>;
  complete(ctx: TenantContext, uploadId: string, parts: PartRef[]): Promise<ObjectRef>;
  abort(ctx: TenantContext, uploadId: string): Promise<void>;
}

interface ObjectReader {
  presign(ctx: TenantContext, objectId: string, ttlSeconds: number): Promise<PresignedUrl>;
  stream(ctx: TenantContext, objectId: string, range?: ByteRange): Promise<ReadableStream>;
  head(ctx: TenantContext, objectId: string): Promise<ObjectMetadata>;
}

interface ObjectRef {
  readonly objectId: string;        // opaque — the ONLY public identifier
  readonly sizeBytes: number;
  readonly contentType: string;
  readonly sha256: string;
  readonly createdAt: Date;
  // NO key. NO bucket. NO provider identifier.
}
```

**`ObjectRef` deliberately carries no key or bucket.** The type makes path exposure impossible rather than relying on every caller to omit it — the same structural technique used for the transaction-bound event publisher (`13-event-platform/transactional-outbox.md`).

**Every method takes a `TenantContext` as its first parameter**, so an operation without tenant scope does not typecheck (`16-security/tenant-isolation.md`).

**There is no `update` and no `overwrite`.** Immutability is expressed in the interface, not documented alongside it.

## Database impact

**No new tables and no schema change.** Object metadata uses `media_assets` as defined in Phase 3 — `tenant_id`, `kind`, `object_key`, `transforms JSONB`, `status`, with `UNIQUE (tenant_id, object_key)` (`03-database/tables.md`).

`media_assets` is workspace-owned and **RLS-protected** under the standard policy. Every index leads with `tenant_id` (`03-database/indexes.md`).

**Metadata writes and event publication share one transaction** (`13-event-platform/transactional-outbox.md`), so an object recorded as available and its `ObjectUploaded` notification cannot diverge.

## Security

- Object keys are **tenant-prefixed and server-constructed** (`16-security/tenant-isolation.md`).
- **Buckets are never public**; access is presigned or CDN-signed with short TTLs.
- **SSE-KMS encrypts every object at rest** (`16-security/encryption.md`).
- Presigned URLs are bearer credentials — **never logged**, 15-minute lifetime, single object.
- Content type detection and magic-byte validation follow `16-security/api-security.md`.
- Upload, download, and delete of exports and backups are audited (`16-security/audit.md`).

## Performance

| Operation | Target |
|---|---|
| Presign | **p95 < 10 ms** — signature computation, no provider call |
| `head` | p95 < 15 ms — served from `media_assets`, not the store |
| Upload initiate | p95 < 50 ms |
| Complete + verify | p95 < 200 ms |
| Streamed download | Provider-bound; CDN-served for public assets |
| Verification sweep | Rate-limited background; yields to production |

**`head` reads PostgreSQL, not the object store.** System metadata is duplicated at write specifically so metadata reads never pay a provider round trip — the difference between 15 ms and 80 ms on a path that fires on every media render.

## Observability

- **Metrics:** `storage_objects_total{bucket,tenant_class}`, `storage_bytes_total{bucket}` (gauge), `upload_initiated_total`, `upload_completed_total{outcome}`, `upload_duration_seconds`, `multipart_aborted_total`, `checksum_mismatches_total` (**invariant — must be zero**), `content_type_mismatches_total`, `verification_sweep_objects_total{outcome}`, `presign_total{purpose}`.
- **Logging:** object id, tenant id, bucket, size, content type, outcome — **never keys, never presigned URLs**.
- **Alerts:** `checksum_mismatches_total` non-zero (**page — corruption**); `multipart_aborted_total` rising (clients failing mid-upload); `content_type_mismatches_total` spike (probing or a broken client); upload failure rate above baseline; storage growth deviating sharply from content creation.

**A checksum mismatch pages because it means the platform is holding bytes that are not what it recorded.** The cause is either provider corruption or a bug in the write path, and both require the object to be restored before it is served again.

## Cross references

- `storage-abstraction.md` — the driver translating these operations per provider
- `blob-lifecycle.md` — states an object moves through
- `media-processing.md` — derivations created from these objects
- `cdn.md` — delivery of immutable objects with long TTLs
- `retention.md` — noncurrent version expiry, soft delete, GC
- `backups.md` — the backup bucket and Object Lock
- `storage-apis.md` — the frozen public interface
- `16-security/tenant-isolation.md` — key format and prefix isolation
- `16-security/encryption.md` — SSE-KMS
- `16-security/api-security.md` — upload validation and magic bytes
- `03-database/tables.md` — `media_assets`
- `13-event-platform/transactional-outbox.md` — event publication
