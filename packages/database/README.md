# `@contentos/database`

**Specified by** [`03-database/`](../../contentos-docs/03-database/) (tables, migrations, indexes) and [`16-security/row-level-security.md`](../../contentos-docs/16-security/row-level-security.md) (roles, policies, exception set).

## What this package owns

| Concern                                                   | Source                                        |
| --------------------------------------------------------- | --------------------------------------------- |
| Migration runner, checksums, append-only enforcement      | `03-database/migrations.md`                   |
| The closed RLS exception sets                             | `16-security/row-level-security.md`           |
| The RLS conformance suite                                 | Sprint 0 exit criterion                       |
| `TenantScopedConnection` — `withTenant` / `withoutTenant` | `row-level-security.md` §Interfaces           |
| Pool-mode enforcement                                     | `row-level-security.md` §"Connection pooling" |

Migration SQL lives in [`infrastructure/migrations/`](../../infrastructure/migrations/), per the frozen layout ("applied via packages/database").

## Rules that govern this package

**`drizzle-orm` may be imported ONLY here.** One schema owner; the lint rule blocks it everywhere else.

**`ENABLE` _and_ `FORCE` on every non-exception table.** `ENABLE` activates policies for ordinary roles; `FORCE` additionally applies them to the table owner. Without `FORCE`, any connection as the owning role sees every tenant's rows — and its absence is invisible until it matters.

**The policy is identical on every table**, differing only in table name. Uniformity is what makes automated verification possible: any deviation is a finding, not a judgement call. `workspaces` is the one approved variant (it keys on `id`, because `workspaces.id` **is** `tenant_id`), and the variant is registered so it reads as approved rather than as drift.

**`WITH CHECK` is mandatory.** Its absence is worse than a read leak: with `USING` alone a subject can `INSERT` a row carrying another tenant's id, into a tenant they cannot even read.

**The exception set is exactly five, closed.** A sixth requires an ADR. The conformance suite fails the build on a sixth _and_ on a missing one.

**`SET LOCAL`, never `SET`.** A plain `SET` persists on a pooled connection, so the next borrower inherits the previous tenant's context. `withTenant` opens the transaction and sets context as one unit, so a connection without context is not constructible.

**Statement pooling is prohibited** and `createTenantScopedConnection` refuses to build in that mode.

**Migrations are append-only.** An applied migration's checksum is re-verified on every run; editing shipped SQL fails the deploy. Rollback is by forward migration.

## Status

**ADR-022 (PostgreSQL 17 + Drizzle) is Proposed.** Sprint 0 proceeds on the working assumption; it must be accepted or accepted-as-risk **before the first migration ships**. The Drizzle schema objects and the driver binding land once the dependency is installable — the DDL in `infrastructure/migrations/` is authoritative in the meantime.
