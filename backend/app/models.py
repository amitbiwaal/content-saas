"""ORM models for every PRD §14 entity.

Relationships are one-to-many from ``project`` downward unless noted. JSON
columns hold the semi-structured payloads (SERP results, debate transcripts,
outline nodes, score breakdowns) so M0 can persist the full pipeline without a
column-per-field explosion; these can be normalised later if querying demands.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    JSON,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


def _uuid() -> str:
    return str(uuid.uuid4())


def _now() -> datetime:
    return datetime.now(timezone.utc)


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=_now, onupdate=_now
    )


# --------------------------------------------------------------------------- #
# Root of a content job
# --------------------------------------------------------------------------- #
class Project(TimestampMixin, Base):
    __tablename__ = "project"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    website: Mapped[str] = mapped_column(String(255))
    topic: Mapped[str] = mapped_column(String(512))
    keyword: Mapped[str] = mapped_column(String(255))
    country: Mapped[str] = mapped_column(String(8), default="US")
    audience: Mapped[str | None] = mapped_column(String(512), nullable=True)
    tone: Mapped[str | None] = mapped_column(String(255), nullable=True)
    goal: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Pipeline stage: research | council | editor | ready | published
    stage: Mapped[str] = mapped_column(String(32), default="research")
    # Which providers join the council (FR-3.2); list of seat->provider entries.
    council_config: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    # Human-in-the-loop review state (step-by-step "review mode"). Maps a gated
    # stage key (research | council | outline | draft) to its approval record:
    # ``{"status": "pending"|"approved", "at": iso8601, "by": str,
    #    "feedback": str|None}``. Empty/None means the project runs in auto mode
    # (the streaming pipeline) with no per-stage human gate.
    checkpoints: Mapped[dict | None] = mapped_column(JSON, nullable=True)

    research: Mapped[list["Research"]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )
    agent_runs: Mapped[list["AgentRun"]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )
    debates: Mapped[list["Debate"]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )
    decisions: Mapped[list["Decision"]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )
    outlines: Mapped[list["Outline"]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )
    drafts: Mapped[list["Draft"]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )
    usages: Mapped[list["Usage"]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )


# --------------------------------------------------------------------------- #
# Normalised brief input (Research Intelligence, PRD §9.4)
# --------------------------------------------------------------------------- #
class Research(TimestampMixin, Base):
    __tablename__ = "research"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    project_id: Mapped[str] = mapped_column(ForeignKey("project.id"), index=True)

    serp: Mapped[list | None] = mapped_column(JSON, nullable=True)
    headings: Mapped[list | None] = mapped_column(JSON, nullable=True)
    paa: Mapped[list | None] = mapped_column(JSON, nullable=True)  # People Also Ask
    entities: Mapped[list | None] = mapped_column(JSON, nullable=True)
    sources: Mapped[list | None] = mapped_column(JSON, nullable=True)
    intent: Mapped[str | None] = mapped_column(String(64), nullable=True)
    provider: Mapped[str] = mapped_column(String(32), default="mock")

    project: Mapped["Project"] = relationship(back_populates="research")


# --------------------------------------------------------------------------- #
# One agent execution (PRD §8)
# --------------------------------------------------------------------------- #
class AgentRun(TimestampMixin, Base):
    __tablename__ = "agent_run"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    project_id: Mapped[str] = mapped_column(ForeignKey("project.id"), index=True)

    role: Mapped[str] = mapped_column(String(64))  # e.g. content_strategist
    provider: Mapped[str] = mapped_column(String(32))  # openai | anthropic | ...
    model: Mapped[str] = mapped_column(String(128))
    round: Mapped[int] = mapped_column(Integer, default=1)  # 1=report 2=debate
    output: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    tokens: Mapped[int] = mapped_column(Integer, default=0)
    cost_cents: Mapped[float] = mapped_column(Float, default=0.0)

    project: Mapped["Project"] = relationship(back_populates="agent_runs")


# --------------------------------------------------------------------------- #
# Round 2 transcript (PRD §8.2)
# --------------------------------------------------------------------------- #
class Debate(TimestampMixin, Base):
    __tablename__ = "debate"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    project_id: Mapped[str] = mapped_column(ForeignKey("project.id"), index=True)

    # Messages tagged proposes | conflict | agree.
    messages: Mapped[list | None] = mapped_column(JSON, nullable=True)
    conflicts: Mapped[list | None] = mapped_column(JSON, nullable=True)

    project: Mapped["Project"] = relationship(back_populates="debates")


# --------------------------------------------------------------------------- #
# Judge output / audit log (PRD §8.3)
# --------------------------------------------------------------------------- #
class Decision(TimestampMixin, Base):
    __tablename__ = "decision"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    project_id: Mapped[str] = mapped_column(ForeignKey("project.id"), index=True)

    source: Mapped[str | None] = mapped_column(String(64), nullable=True)  # role
    point: Mapped[str] = mapped_column(Text)
    # accepted | rejected | needs_evidence | merge | manual_review
    label: Mapped[str] = mapped_column(String(32))
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    overridden_by: Mapped[str | None] = mapped_column(String(64), nullable=True)

    project: Mapped["Project"] = relationship(back_populates="decisions")


# --------------------------------------------------------------------------- #
# Article skeleton (PRD §6)
# --------------------------------------------------------------------------- #
class Outline(TimestampMixin, Base):
    __tablename__ = "outline"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    project_id: Mapped[str] = mapped_column(ForeignKey("project.id"), index=True)

    nodes: Mapped[list | None] = mapped_column(JSON, nullable=True)  # H1/H2/H3 tree
    elements: Mapped[list | None] = mapped_column(JSON, nullable=True)  # table/FAQ/CTA
    schema_hooks: Mapped[list | None] = mapped_column(JSON, nullable=True)

    project: Mapped["Project"] = relationship(back_populates="outlines")
    drafts: Mapped[list["Draft"]] = relationship(back_populates="outline")


# --------------------------------------------------------------------------- #
# Article content + versions (PRD §7)
# --------------------------------------------------------------------------- #
class Draft(TimestampMixin, Base):
    __tablename__ = "draft"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    project_id: Mapped[str] = mapped_column(ForeignKey("project.id"), index=True)
    outline_id: Mapped[str | None] = mapped_column(
        ForeignKey("outline.id"), nullable=True, index=True
    )

    sections: Mapped[list | None] = mapped_column(JSON, nullable=True)
    word_count: Mapped[int] = mapped_column(Integer, default=0)
    version: Mapped[int] = mapped_column(Integer, default=1)

    project: Mapped["Project"] = relationship(back_populates="drafts")
    outline: Mapped["Outline | None"] = relationship(back_populates="drafts")
    scores: Mapped[list["Score"]] = relationship(
        back_populates="draft", cascade="all, delete-orphan"
    )
    claims: Mapped[list["Claim"]] = relationship(
        back_populates="draft", cascade="all, delete-orphan"
    )
    internal_links: Mapped[list["InternalLink"]] = relationship(
        back_populates="draft", cascade="all, delete-orphan"
    )


# --------------------------------------------------------------------------- #
# Quality grades — the eight scores (PRD §10)
# --------------------------------------------------------------------------- #
class Score(TimestampMixin, Base):
    __tablename__ = "score"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    draft_id: Mapped[str] = mapped_column(ForeignKey("draft.id"), index=True)

    seo: Mapped[float] = mapped_column(Float, default=0.0)
    aeo: Mapped[float] = mapped_column(Float, default=0.0)
    geo: Mapped[float] = mapped_column(Float, default=0.0)
    heo: Mapped[float] = mapped_column(Float, default=0.0)
    eeat: Mapped[float] = mapped_column(Float, default=0.0)
    fact: Mapped[float] = mapped_column(Float, default=0.0)
    spam: Mapped[float] = mapped_column(Float, default=0.0)  # lower is better
    originality: Mapped[float] = mapped_column(Float, default=0.0)  # higher better (PRD §20)
    publish: Mapped[float] = mapped_column(Float, default=0.0)

    draft: Mapped["Draft"] = relationship(back_populates="scores")


# --------------------------------------------------------------------------- #
# Fact-check record (PRD §9)
# --------------------------------------------------------------------------- #
class Claim(TimestampMixin, Base):
    __tablename__ = "claim"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    draft_id: Mapped[str] = mapped_column(ForeignKey("draft.id"), index=True)

    text: Mapped[str] = mapped_column(Text)
    source: Mapped[str | None] = mapped_column(Text, nullable=True)
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    risk: Mapped[str] = mapped_column(String(16), default="low")  # low|medium|high
    # accepted | rejected | needs_evidence | merge | manual_review
    label: Mapped[str | None] = mapped_column(String(32), nullable=True)

    draft: Mapped["Draft"] = relationship(back_populates="claims")


# --------------------------------------------------------------------------- #
# Link suggestion (PRD §11.2)
# --------------------------------------------------------------------------- #
class InternalLink(TimestampMixin, Base):
    __tablename__ = "internal_link"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    draft_id: Mapped[str] = mapped_column(ForeignKey("draft.id"), index=True)

    target_url: Mapped[str] = mapped_column(Text)
    anchor: Mapped[str] = mapped_column(String(255))

    draft: Mapped["Draft"] = relationship(back_populates="internal_links")


# --------------------------------------------------------------------------- #
# Per-website knowledge graph (PRD §11.1)
# --------------------------------------------------------------------------- #
class Memory(TimestampMixin, Base):
    __tablename__ = "memory"
    # A website's knowledge graph has one node per topic — enforce it so upsert
    # semantics are well-defined and re-runs don't create duplicate nodes.
    __table_args__ = (
        UniqueConstraint("website", "topic_node", name="uq_memory_site_topic"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    website: Mapped[str] = mapped_column(String(255), index=True)
    topic_node: Mapped[str] = mapped_column(String(512))
    cluster: Mapped[str | None] = mapped_column(String(255), nullable=True)
    coverage: Mapped[float] = mapped_column(Float, default=0.0)


# --------------------------------------------------------------------------- #
# Cost tracking (PRD §13)
# --------------------------------------------------------------------------- #
class Usage(TimestampMixin, Base):
    __tablename__ = "usage"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    project_id: Mapped[str] = mapped_column(ForeignKey("project.id"), index=True)
    run_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)

    tokens: Mapped[int] = mapped_column(Integer, default=0)
    cost_cents: Mapped[float] = mapped_column(Float, default=0.0)

    project: Mapped["Project"] = relationship(back_populates="usages")
