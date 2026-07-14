"""Full-pipeline endpoints (PRD §7).

``POST /run``         — batch: run end-to-end, return the gated summary.
``GET  /run/stream``  — SSE: stream stage/agent/decision events live (PRD §16).
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.db import SessionLocal, get_db
from app.models import Project
from app.pipeline.service import run_full_pipeline, stream_full_pipeline

router = APIRouter(prefix="/api/projects", tags=["pipeline"])

logger = logging.getLogger("contentos.pipeline")

# SSE heartbeat interval: emit a comment line during silent stages so reverse
# proxies (nginx/ELB/Cloudflare) don't drop the idle upstream connection.
_HEARTBEAT_S = 15.0


@router.post("/{project_id}/run")
def run_pipeline(project_id: str, db: Session = Depends(get_db)) -> dict:
    """Run Research → Council → Outline → Article → Fact-check → Scores → Gate →
    Compliance for the project and persist every artifact."""
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="project not found")
    return run_full_pipeline(db, project)


@router.get("/{project_id}/run/stream")
async def run_pipeline_stream(
    project_id: str, request: Request, db: Session = Depends(get_db)
) -> StreamingResponse:
    """Stream the pipeline as Server-Sent Events.

    Emits ``stage`` / ``report`` / ``conflict`` / ``decision`` / ``done`` events
    so the UI can render the council debate and stage progress in real time
    (PRD §16). GET so it works with the browser ``EventSource`` API.

    The pipeline runs in a worker thread (its own DB session); the async
    consumer forwards events, sends periodic heartbeats during silent stages,
    and — on client disconnect — signals cancellation so no further paid LLM
    work starts.
    """
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="project not found")

    async def event_stream():
        loop = asyncio.get_running_loop()
        events: asyncio.Queue = asyncio.Queue()
        cancel = threading.Event()

        def worker() -> None:
            # A dedicated session so the pipeline's DB access is confined to this
            # thread and independent of the request-scoped session's lifecycle.
            session = SessionLocal()

            def emit(item: tuple[str, dict | None]) -> None:
                loop.call_soon_threadsafe(events.put_nowait, item)

            try:
                proj = session.get(Project, project_id)
                if proj is None:
                    emit(("error", {"detail": "project not found"}))
                    return
                for ev in stream_full_pipeline(session, proj, cancel=cancel):
                    emit(("event", ev))
            except Exception:  # noqa: BLE001 - report a generic failure, log detail
                logger.exception("pipeline stream failed for project %s", project_id)
                emit(("error", {"detail": "pipeline failed"}))
            finally:
                session.close()
                emit(("end", None))

        thread = threading.Thread(target=worker, daemon=True)
        thread.start()
        try:
            while True:
                if await request.is_disconnected():
                    cancel.set()
                    break
                try:
                    kind, payload = await asyncio.wait_for(
                        events.get(), timeout=_HEARTBEAT_S
                    )
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
                    continue
                if kind == "end":
                    break
                if kind == "error":
                    yield f"event: error\ndata: {json.dumps(payload)}\n\n"
                    continue
                yield f"event: {payload['event']}\ndata: {json.dumps(payload['data'])}\n\n"
        finally:
            cancel.set()
            # Let the worker observe cancellation and close its session; it is a
            # daemon thread so a stuck LLM call cannot block process shutdown.
            await asyncio.to_thread(thread.join, 5.0)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
