"""SQLAlchemy 2.0 engine + session wiring.

SQLite for local dev (zero setup); point ``DATABASE_URL`` at Postgres for prod.
Tables auto-create on startup in dev (see ``init_db``); production should move
to Alembic migrations before M2.
"""

from __future__ import annotations

from collections.abc import Iterator

from sqlalchemy import create_engine, event
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import get_settings

settings = get_settings()

# check_same_thread is a SQLite-only flag; harmless to compute conditionally.
# ``timeout`` sets SQLite's busy-timeout (seconds) so a concurrent writer waits
# for the lock instead of immediately raising "database is locked".
_is_sqlite = settings.database_url.startswith("sqlite")
connect_args = {"check_same_thread": False, "timeout": 30} if _is_sqlite else {}

# For managed Postgres (the prod path — SQLite is rejected in prod), idle pooled
# connections get closed by the server/pgbouncer; ``pool_pre_ping`` validates a
# connection on checkout (recycling dead ones instead of 500-ing) and
# ``pool_recycle`` proactively drops connections older than 30 min.
engine_kwargs: dict = {"future": True, "connect_args": connect_args}
if not _is_sqlite:
    engine_kwargs["pool_pre_ping"] = True
    engine_kwargs["pool_recycle"] = 1800

engine = create_engine(settings.database_url, **engine_kwargs)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

if _is_sqlite:
    # A pipeline run now executes in a detached background worker while stream
    # requests read concurrently. Default SQLite (rollback-journal) lets a reader
    # block the writer, causing "database is locked". WAL allows concurrent
    # readers alongside one writer; busy_timeout makes a brief writer/writer
    # overlap wait instead of erroring. (No effect on Postgres in prod.)
    @event.listens_for(engine, "connect")
    def _sqlite_pragmas(dbapi_conn, _record):  # noqa: ANN001
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA busy_timeout=30000")
        cur.execute("PRAGMA synchronous=NORMAL")
        cur.close()


class Base(DeclarativeBase):
    """Declarative base for all ORM models."""


def get_db() -> Iterator[Session]:
    """FastAPI dependency yielding a request-scoped session."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db() -> None:
    """Create all tables. Dev convenience only — prod uses Alembic migrations.

    In production (``APP_ENV=prod``) this is a no-op: schema is managed by
    ``alembic upgrade head`` at deploy time, never by DDL from the app process
    (``create_all`` cannot ALTER existing tables, so it silently diverges).
    """
    if settings.is_prod:
        return
    # Import models so they register on Base.metadata before create_all.
    from app import models  # noqa: F401

    Base.metadata.create_all(bind=engine)
