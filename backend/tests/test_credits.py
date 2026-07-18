"""Credit plan allowance, monthly refill, and plan-change top-up (unit level)."""

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app import credits as credits_mod
from app.db import Base
from app.models import User


@pytest.fixture()
def session(tmp_path):
    engine = create_engine(
        f"sqlite:///{tmp_path / 'credits.db'}", connect_args={"check_same_thread": False}
    )
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine, expire_on_commit=False)()
    try:
        yield s
    finally:
        s.close()
        engine.dispose()


def test_refill_grants_once_per_month(session):
    u = User(email="a@x.ai", credits=0, plan="free")
    session.add(u)
    session.commit()

    assert credits_mod.apply_monthly_refill(session, u) == 500
    assert u.credits == 500
    # second call in the same month is a no-op
    assert credits_mod.apply_monthly_refill(session, u) == 0
    assert u.credits == 500


def test_refill_never_reduces_a_higher_balance(session):
    # Balance above the allowance (e.g. an admin top-up) is left untouched.
    u = User(email="b@x.ai", credits=9000, plan="free")
    session.add(u)
    session.commit()
    assert credits_mod.apply_monthly_refill(session, u) == 0
    assert u.credits == 9000


def test_pro_allowance(session):
    u = User(email="c@x.ai", credits=0, plan="pro")
    session.add(u)
    session.commit()
    assert credits_mod.apply_monthly_refill(session, u) == 5000
    assert u.credits == 5000


def test_set_plan_tops_up_to_new_allowance(session):
    u = User(email="d@x.ai", credits=100, plan="free")
    session.add(u)
    session.commit()
    added = credits_mod.set_plan(session, u, "pro")
    session.commit()
    assert u.plan == "pro"
    assert u.credits == 5000
    assert added == 4900


def test_set_plan_rejects_unknown(session):
    u = User(email="e@x.ai", credits=0)
    session.add(u)
    session.commit()
    with pytest.raises(HTTPException):
        credits_mod.set_plan(session, u, "platinum")
