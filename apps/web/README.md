# `@contentos/web`

**Specified by** [`15-application-ui/`](../../contentos-docs/15-application-ui/).

Customer application shell. **Scaffolded in Sprint 0 against frozen API contracts** — 127 endpoints with schemas mean the shell, design system, state patterns, and accessibility scaffolding are all buildable before a handler exists.

## Status

Shell only. Screens, routing, design tokens, and the ten Common UI States arrive in **Sprint 5**. Nothing in this scaffold anticipates them, so nothing has to be unpicked.

## Rules that will govern it

- **UI never bypasses server validation.** UI is informative; the server owns truth.
- **Status is read-only.** Transitions come from APIs; no client-side workflow logic.
- **Navigation never exposes inaccessible resources.** Permissions control visibility; no orphan screens.
- **No provider names, no routing decisions, no raw prompts** ever reach the client.
