"""Pydantic API schemas (request/response models).

Kept separate from ORM models so the wire contract can evolve independently of
the persistence layer.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


# --------------------------------------------------------------------------- #
# Projects
# --------------------------------------------------------------------------- #
class ProjectCreate(BaseModel):
    """New Content Project brief (PRD §9.3 / FR-3.1)."""

    website: str
    topic: str
    keyword: str
    country: str = "US"
    audience: str | None = None
    tone: str | None = None
    goal: str | None = None
    # Desired article format (e.g. "How-to", "Listicle") and target body length.
    article_type: str | None = None
    word_count: int | None = Field(default=None, ge=100, le=10000)
    # Optional seat->provider overrides for this project (FR-3.2).
    council_config: dict | None = None


class ProjectOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    website: str
    topic: str
    keyword: str
    country: str
    audience: str | None
    tone: str | None
    goal: str | None
    article_type: str | None = None
    word_count: int | None = None
    stage: str
    council_config: dict | None
    # Per-stage human approval state for review mode (None in auto mode).
    checkpoints: dict | None = None
    created_at: datetime
    updated_at: datetime


# --------------------------------------------------------------------------- #
# Council / debate (read models)
# --------------------------------------------------------------------------- #
class DecisionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    source: str | None
    point: str
    label: str
    reason: str | None
    overridden_by: str | None


class AgentReport(BaseModel):
    """Round-1 output from one council seat (PRD §8.2)."""

    role: str
    provider: str
    model: str
    recommendations: list[str] = Field(default_factory=list)
    confidence: float = 0.0


# --------------------------------------------------------------------------- #
# Scoring (PRD §10)
# --------------------------------------------------------------------------- #
class ScoreOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    seo: float
    aeo: float
    geo: float
    heo: float
    eeat: float
    fact: float
    spam: float
    publish: float


class GateResult(BaseModel):
    """Publish-gate verdict (PRD §10)."""

    passed: bool
    reasons: list[str] = Field(default_factory=list)
    scores: ScoreOut
