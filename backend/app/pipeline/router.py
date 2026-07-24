"""Full-pipeline endpoints (PRD §7).

``POST /run``         — batch: run end-to-end, return the gated summary.
``GET  /run/stream``  — SSE: tail a durable run's live events (PRD §16).

The streaming run is decoupled from the connection: it executes in a detached
background worker (see :mod:`app.pipeline.hub`) that survives client disconnects,
and this endpoint is a read-only *tail* that can re-attach and replay on reconnect.
"""

from __future__ import annotations

import asyncio
import json
import logging

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app import credits as credits_mod
from app.db import get_db
from app.models import Project, User
from app.pipeline.hub import active_run, get_hub, latest_run, start_run
from app.pipeline.service import STAGES, run_full_pipeline
from app.review.service import stage_status
from app.security import decode_token, get_current_user

_SSE_HEADERS = {
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
    "Connection": "keep-alive",
}


def _resolve_user(token: str | None, authorization: str | None, db: Session) -> User | None:
    """Resolve the user from a Bearer header or a ``?token=`` query param.

    EventSource cannot send an Authorization header, so the live-run URL carries
    the JWT as a query param; regular callers use the header. Returns None when no
    valid token is present."""
    raw = None
    if authorization and authorization[:7].lower() == "bearer ":
        raw = authorization[7:].strip()
    raw = raw or token
    uid = decode_token(raw) if raw else None
    return db.get(User, uid) if uid else None


def _sse_error(detail: str) -> StreamingResponse:
    """A one-shot SSE stream that reports an error the client can render (the
    frontend's run reducer handles ``event: error``)."""
    async def gen():
        yield f"event: error\ndata: {json.dumps({'detail': detail})}\n\n"
    return StreamingResponse(gen(), media_type="text/event-stream", headers=_SSE_HEADERS)

# Resuming a gated run at a stage requires its guarding gate to be approved
# first, so a client can't skip a pause. Every content step is gated, so each
# resume point checks the previous step's checkpoint (polish/factcheck sit
# behind the outline/draft sign-offs; keywords/competitors regenerate the
# research artifact itself, whose gate is pending at that point).
_RESUME_REQUIRES = {
    "council": "research",
    "outline": "council",
    "article": "outline",
    "polish": "outline",
    "factcheck": "draft",
    "scoring": "draft",
    "gate": "draft",
    "compliance": "draft",
}

router = APIRouter(prefix="/api/projects", tags=["pipeline"])

logger = logging.getLogger("contentos.pipeline")

# SSE heartbeat interval: emit a comment line during silent stages so reverse
# proxies (nginx/ELB/Cloudflare) don't drop the idle upstream connection.
_HEARTBEAT_S = 15.0


@router.post("/{project_id}/run")
def run_pipeline(
    project_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Run Research → Council → Outline → Article → Fact-check → Scores → Gate →
    Compliance for the project and persist every artifact."""
    project = db.get(Project, project_id)
    if project is None or (project.owner_id is not None and project.owner_id != user.id):
        raise HTTPException(status_code=404, detail="project not found")
    cost = credits_mod.estimate_run_credits(project)
    credits_mod.charge(db, user, cost, "run", project_id=project_id, detail="Batch run")
    db.commit()
    return run_full_pipeline(db, project)


@router.get("/{project_id}/run/stream")
async def run_pipeline_stream(
    project_id: str,
    request: Request,
    db: Session = Depends(get_db),
    gated: bool = Query(False, description="pause after each content stage for human sign-off"),
    from_stage: str | None = Query(
        None, alias="from", description="resume the run at this stage (gated mode)"
    ),
    after: int = Query(
        -1, description="last event id already seen; reconnect/tail from here (-1 = from the top)"
    ),
    token: str | None = Query(None, description="user JWT (EventSource can't send a header)"),
    authorization: str | None = Header(default=None),
) -> StreamingResponse:
    """Stream a pipeline run as Server-Sent Events — a read-only *tail* of a
    durable, connection-independent run.

    The pipeline executes in a detached background worker (:mod:`app.pipeline.hub`),
    so it is NOT tied to this connection: a client disconnect drops the
    subscription but the run keeps going, and a reconnect with ``after=<last id>``
    replays missed events and follows live.

    - Fresh start (``after<0``, no active run) → starts a new run.
    - A run is already executing → attaches to it (no duplicate run).
    - Reconnect (``after>=0``) → re-attaches to the active/most-recent run's hub.

    With ``gated=1`` the run pauses after each content stage (emitting
    ``awaiting_approval`` then ending the stream); the client approves/rejects and
    reopens with ``from=<stage>`` to resume.
    """
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="project not found")
    # Accept the legacy stage names still held by older clients/open tabs.
    from_stage = {"research": "keywords", "draft": "article"}.get(from_stage, from_stage)
    if from_stage is not None and from_stage not in STAGES:
        raise HTTPException(
            status_code=422, detail=f"from must be one of {list(STAGES)}"
        )

    # EVERY stream open — fresh start, gated resume, or reconnect/attach —
    # requires a signed-in owner. Without this, `?from=<stage>` started a full,
    # uncharged, unauthenticated pipeline run on any project id, and a reconnect
    # could tail another user's live run.
    user = _resolve_user(token, authorization, db)
    if user is None:
        db.close()
        return _sse_error("Please sign in to run.")
    if project.owner_id is not None and project.owner_id != user.id:
        db.close()
        return _sse_error("Project not found.")

    # On a native EventSource auto-reconnect the browser resends the last id it
    # saw as the ``Last-Event-ID`` header (the URL has no ``after``); honour it so
    # a reconnect resumes from there instead of replaying the whole run.
    if after < 0:
        hdr = request.headers.get("last-event-id")
        if hdr:
            try:
                after = int(hdr)
            except ValueError:
                pass

    loop = asyncio.get_running_loop()
    running = active_run(db, project_id)
    starting = after < 0 and running is None

    if starting:
        # Enforce the gate: can't resume past a pause the human hasn't signed
        # off. Applies whether or not this leg was opened with gated=1 — the
        # checkpoint ledger is the source of truth, so a client can't skip a
        # pause by dropping the flag.
        required_gate = _RESUME_REQUIRES.get(from_stage)
        if required_gate and stage_status(project.checkpoints, required_gate) != "approved":
            raise HTTPException(
                status_code=409,
                detail=f"stage '{required_gate}' must be approved before resuming at '{from_stage}'",
            )
        # Credits: only a FRESH run (from the top) is charged; a resume
        # (``from`` set) continues the already-charged run.
        if from_stage is None:
            cost = credits_mod.estimate_run_credits(project)
            if int(user.credits) < cost:
                db.close()
                return _sse_error(
                    f"Not enough credits: this run needs {cost} but you have "
                    f"{int(user.credits)}. Top up to continue."
                )
            credits_mod.charge(db, user, cost, "run", project_id=project_id, detail="Live run")
            db.commit()
        run_id = start_run(project_id, gated=gated, from_stage=from_stage, loop=loop)
        hub = get_hub(run_id)
    else:
        # Attach to the in-flight run (or the most recent, for a late reconnect).
        target = running or latest_run(db, project_id)
        hub = get_hub(target.id) if target else None

    # Release the request-scoped session now: the stream can run for minutes and
    # the background run needs the DB. Holding it would pin a connection (and, on
    # SQLite, a lock) for the whole stream. Nothing below touches ``db``.
    db.close()

    async def event_stream():
        if hub is None:
            # The run finished and its in-memory buffer was evicted (or it is
            # executing on another worker): tell the client to reload the finished
            # project rather than hang waiting for events that won't arrive here.
            yield f"event: resync\ndata: {json.dumps({'project_id': project_id})}\n\n"
            return
        q = hub.subscribe_queue(after)
        try:
            while True:
                if await request.is_disconnected():
                    break  # drop the subscription; the detached run keeps going
                try:
                    idx, event = await asyncio.wait_for(q.get(), timeout=_HEARTBEAT_S)
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
                    continue
                if event is None:
                    break  # end sentinel — run reached a terminal/awaiting state
                yield f"id: {idx}\nevent: {event['event']}\ndata: {json.dumps(event['data'])}\n\n"
        finally:
            hub.unsubscribe(q)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
