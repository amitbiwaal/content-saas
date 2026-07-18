"""DATABASE_URL normalization — accept whatever a host injects, pin psycopg3."""

from app.config import Settings


def test_plain_postgresql_gets_psycopg_driver():
    s = Settings(database_url="postgresql://u:p@host:5432/db")
    assert s.database_url == "postgresql+psycopg://u:p@host:5432/db"


def test_postgres_scheme_is_upgraded():
    # Some platforms hand out the older postgres:// scheme.
    s = Settings(database_url="postgres://u:p@host/db")
    assert s.database_url == "postgresql+psycopg://u:p@host/db"


def test_explicit_driver_is_left_alone():
    s = Settings(database_url="postgresql+psycopg://u:p@host/db")
    assert s.database_url == "postgresql+psycopg://u:p@host/db"


def test_sqlite_is_untouched():
    s = Settings(database_url="sqlite:///./contentos.db")
    assert s.database_url == "sqlite:///./contentos.db"
