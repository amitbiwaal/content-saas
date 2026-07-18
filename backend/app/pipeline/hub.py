"""Durable, connection-independent pipeline runs.

The pipeline used to execute *inside* the SSE request: a worker thread streamed
straight to the open connection, and a client disconnect cancelled the run and
rolled back its in-flight stage. Every network blip, tab close, or deploy
therefore destroyed minutes of (real-money) work.

This module decouples the run from the connection:

* :func:`start_run` creates a durable :class:`~app.models.Run` row and spawns a
  detached daemon worker that runs the pipeline to completion **regardless of any
  client**. It writes to its own DB session and — as today — persists each stage's
  artifact in a short transaction.
* Every progress event is pushed into an in-process :class:`RunHub` that keeps an
  ordered ``buffer`` plus a set of live subscriber queues. The SSE endpoint is now
  a read-only *tail* of a hub: it replays the buffer from an offset (so a
  reconnect catches up on what it missed) and then follows live events. A client
  disconnect just drops its subscription — the run keeps going.
* On process start, :func:`reap_interrupted` flips any ``running`` row left behind
  by a crashed/redeployed process to ``interrupted`` (the per-stage artifacts are
  already committed, so nothing is lost and the run can be resumed).

Scope note: the hub lives in one process. With a single web worker
(``WEB_CONCURRENCY=1``, recommended at this scale) a reconnect always finds the
hub and replays seamlessly. Under multiple workers a reconnect may land on a
different worker without the hub; the run still completes and its artifacts
persist — the client simply reloads the finished project instead of re-attaching
live. A shared event log (Redis/DB) would remove that caveat (see ARCHITECTURE.md).
"""

from __future__ import annotations

import asyncio
import logging
import threading
from datetime import datetime, timezone

from sqlalchemy import select, update

from app.db import SessionLocal
from app.models import Project, Run
from app.pipeline.service import stream_full_pipeline

logger = logging.getLogger("contentos.pipeline.hub")

# Cap the number of retained hubs so completed runs' buffers don't grow without
# bound; a just-finished run stays available briefly for a reconnecting client.
_MAX_HUBS = 16


class RunHub:
    """In-process fan-out for one run's events: an ordered buffer + live queues.

    All mutation of ``buffer``/``subscribers`` happens on the event loop thread
    (the worker thread only calls :meth:`deliver`/:meth:`close`, which marshal via
    ``loop.call_soon_threadsafe``), so no locking is needed.
    """

    def __init__(self, run_id: str, project_id: str, loop: asyncio.AbstractEventLoop):
        self.run_id = run_id
        self.project_id = project_id
        self.loop = loop
        self.buffer: list[dict] = []
        self.subscribers: set[asyncio.Queue] = set()
        self.done = False
        self.cancel = threading.Event()

    # --- worker-thread side (marshals onto the loop) --------------------- #
    def deliver(self, event: dict) -> None:
        self.loop.call_soon_threadsafe(self._deliver, event)

    def close(self) -> None:
        self.loop.call_soon_threadsafe(self._close)

    # --- loop-thread side ------------------------------------------------ #
    def _deliver(self, event: dict) -> None:
        self.buffer.append(event)
        idx = len(self.buffer) - 1
        for q in list(self.subscribers):
            q.put_nowait((idx, event))

    def _close(self) -> None:
        self.done = True
        for q in list(self.subscribers):
            q.put_nowait((None, None))  # end sentinel

    def subscribe_queue(self, after: int) -> asyncio.Queue:
        """Register a subscriber and return its queue, pre-loaded with the replay.

        ``after`` is the last index the client already has (-1 for a fresh
        stream). Pre-loading ``buffer[after+1:]`` and registering happen with no
        ``await`` in between, so — on the single-threaded loop — no event can slip
        through the gap and none is duplicated. Items are ``(index, event)``; a
        terminal ``(None, None)`` sentinel marks the end. Call :meth:`unsubscribe`
        when the consumer is done. Must be called from the loop thread.
        """
        q: asyncio.Queue = asyncio.Queue()
        for i in range(after + 1, len(self.buffer)):
            q.put_nowait((i, self.buffer[i]))
        if self.done:
            q.put_nowait((None, None))
        else:
            self.subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self.subscribers.discard(q)


# run_id -> RunHub, plus creation order for pruning.
_HUBS: dict[str, RunHub] = {}
_ORDER: list[str] = []


def get_hub(run_id: str) -> RunHub | None:
    return _HUBS.get(run_id)


def _prune() -> None:
    while len(_HUBS) > _MAX_HUBS:
        for rid in list(_ORDER):
            hub = _HUBS.get(rid)
            if hub is None:
                _ORDER.remove(rid)
                continue
            if hub.done:  # only evict finished runs
                _HUBS.pop(rid, None)
                _ORDER.remove(rid)
                break
        else:
            break  # nothing evictable (all still running)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _finish(session, run_id: str, *, status: str, error: str | None = None) -> None:
    """Flip the Run row to a terminal status, reusing the worker's own session.

    Using the pipeline session (rather than a second connection) means one writer
    per run, which avoids SQLite writer/writer contention; on Postgres it is a
    plain row update.
    """
    try:
        session.execute(
            update(Run)
            .where(Run.id == run_id)
            .values(status=status, error=(error[:2000] if error else None), finished_at=_now())
        )
        session.commit()
    except Exception:  # noqa: BLE001 - finalisation must never mask the run result
        logger.exception("failed to finalize run %s -> %s", run_id, status)
        session.rollback()


def active_run(db, project_id: str) -> Run | None:
    """The project's currently-executing run, if any."""
    return db.scalars(
        select(Run)
        .where(Run.project_id == project_id, Run.status == "running")
        .order_by(Run.created_at.desc())
    ).first()


def latest_run(db, project_id: str) -> Run | None:
    return db.scalars(
        select(Run)
        .where(Run.project_id == project_id)
        .order_by(Run.created_at.desc())
    ).first()


def reap_interrupted() -> int:
    """Mark runs left ``running`` by a dead process as ``interrupted`` (startup).

    Safe to call once at boot: a fresh process owns no hubs, so any ``running``
    row is an orphan from a previous process. Returns the number reaped.
    """
    with SessionLocal() as session:
        rows = list(session.scalars(select(Run).where(Run.status == "running")))
        for r in rows:
            r.status = "interrupted"
            r.finished_at = _now()
        session.commit()
        if rows:
            logger.warning("reaped %d interrupted run(s) at startup", len(rows))
        return len(rows)


def start_run(
    project_id: str,
    *,
    gated: bool,
    from_stage: str | None,
    loop: asyncio.AbstractEventLoop,
) -> str:
    """Create a durable Run row + hub and spawn the detached worker. Returns run_id."""
    with SessionLocal() as session:
        run = Run(
            project_id=project_id,
            status="running",
            stage=from_stage or "research",
            gated=gated,
        )
        session.add(run)
        session.commit()
        run_id = run.id

    hub = RunHub(run_id, project_id, loop)
    _HUBS[run_id] = hub
    _ORDER.append(run_id)
    _prune()

    thread = threading.Thread(
        target=_worker,
        args=(run_id, project_id, gated, from_stage, hub),
        name=f"run-{run_id[:8]}",
        daemon=True,
    )
    thread.start()
    return run_id


def _worker(
    run_id: str, project_id: str, gated: bool, from_stage: str | None, hub: RunHub
) -> None:
    """Run the pipeline to completion, feeding the hub. Detached from any request."""
    session = SessionLocal()
    saw_awaiting = False
    try:
        proj = session.get(Project, project_id)
        if proj is None:
            hub.deliver({"event": "error", "data": {"detail": "project not found"}})
            _finish(session, run_id, status="error", error="project not found")
            return
        for ev in stream_full_pipeline(
            session, proj, cancel=hub.cancel, start_stage=from_stage, gated=gated
        ):
            hub.deliver({"event": ev["event"], "data": ev["data"]})
            if ev["event"] == "awaiting_approval":
                saw_awaiting = True
    except Exception as exc:  # noqa: BLE001 - report generic failure, log detail
        logger.exception("run %s failed for project %s", run_id, project_id)
        hub.deliver({"event": "error", "data": {"detail": "pipeline failed"}})
        try:
            session.rollback()
        except Exception:  # noqa: BLE001
            pass
        _finish(session, run_id, status="error", error=str(exc))
    else:
        final = "interrupted" if hub.cancel.is_set() else ("awaiting" if saw_awaiting else "done")
        _finish(session, run_id, status=final)
    finally:
        session.close()
        hub.close()
