# Archive — v1 documents (historical reference only)

These documents describe **ContentOS v1**: the Python/FastAPI + Next.js implementation in `backend/` and `frontend/`, whose product model is *four-model council → Judge → eight scores → publish gate*.

Per **ADR-016**, v2 is a greenfield rebuild on the TypeScript stack specified in `contentos-docs/`. These files are retained as historical reference and must not be treated as architecture sources of truth. Do not modify them.

| File | What it is | Superseded by |
|---|---|---|
| `ARCHITECTURE.md` | 2026-07-16 multi-agent architecture audit of the v1 system (grade B−). Its central finding — run lifetime == connection lifetime — is what ADR-004 (Temporal) exists to fix | `contentos-docs/01-system-architecture/` |
| `ContentOS-AI-PRD.md` | Original product requirements (council/judge/8 scores) | `contentos-docs/01-system-architecture/02-product-vision.md` |
| `BUILD-PLAN.md` | Phased build plan for the v1 Python stack | `contentos-docs/` writing order |
| `model-selection-duplicate.md` | Byte-duplicate of the AI Platform model matrix | `contentos-docs/08-ai-platform/model-selection.md` |

**Still live at the repository root, deliberately not archived:**

- `ARCHITECTURE_BASELINE_ARCHIVE.md` — the v2 architecture baseline (formerly `01_SYSTEM_ARCHITECTURE.md`). Frozen: `contentos-docs/` is now canonical, but this remains the record of where it came from.
- `AUDIT.md` — the 2026-07-28 due-diligence audit of v1. **Required reading for v2**: its four blockers (cross-tenant read leak, plaintext CMS credentials, regex-accepted fabricated sources, no payment path) are v2 requirements, not history.
- `DEPLOYMENT.md`, `README.md` — operationally current for the running v1 service.
