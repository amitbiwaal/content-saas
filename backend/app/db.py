"""SQLAlchemy 2.0 engine + session wiring.

SQLite for local dev (zero setup); point ``DATABASE_URL`` at Postgres for prod.
Tables auto-create on startup in dev (see ``init_db``); production should move
to Alembic migrations before M2.
"""

from __future__ import annotations

from collections.abc import Iterator

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import get_settings

settings = get_settings()

# check_same_thread is a SQLite-only flag; harmless to compute conditionally.
# ``timeout`` sets SQLite's busy-timeout (seconds) so a concurrent writer waits
# for the lock instead of immediately raising "database is locked".
connect_args = (
    {"check_same_thread": False, "timeout": 30}
    if settings.database_url.startswith("sqlite")
    else {}
)

engine = create_engine(settings.database_url, connect_args=connect_args, future=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


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
