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
    Boolean,
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


# Free credits granted to a new account (PRD §13 free tier).
SIGNUP_CREDITS = 500


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=_now, onupdate=_now
    )


# --------------------------------------------------------------------------- #
# Accounts (auth + billing)
# --------------------------------------------------------------------------- #
class User(TimestampMixin, Base):
    """A user account.

    Password auth uses a stdlib PBKDF2 hash (``password_hash``); Google Sign-In
    users have no password (``google_sub`` holds the Google subject id instead).
    ``credits`` is the billing balance (PRD §13); the ledger of debits/credits is
    :class:`CreditLedger`. WordPress publish config is :class:`WordPressConfig`.
    """

    __tablename__ = "user"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
    name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    password_hash: Mapped[str | None] = mapped_column(String(255), nullable=True)
    google_sub: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    credits: Mapped[int] = mapped_column(Integer, default=SIGNUP_CREDITS)
    # Billing plan (free | pro | business). Drives the monthly credit allowance
    # (see app.credits.PLAN_CREDITS). A payment provider or an admin sets this;
    # ``credits_refilled_at`` records the last monthly top-up so the refill is
    # granted at most once per calendar month.
    plan: Mapped[str] = mapped_column(String(16), default="free")
    credits_refilled_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # Admin flag (grants the /admin panel + admin API). Bootstrap the first admin
    # via the ADMIN_EMAILS env allow-list (see app.security.user_is_admin); admins
    # can then promote others, which sets this column.
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    # Suspension flag. A suspended account (is_active False) is blocked at login
    # and its live tokens stop resolving (see app.security.get_current_user), so an
    # admin can lock an account out without deleting its work.
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    projects: Mapped[list["Project"]] = relationship(back_populates="owner")
    ledger: Mapped[list["CreditLedger"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    wordpress: Mapped["WordPressConfig | None"] = relationship(
        back_populates="user", uselist=False, cascade="all, delete-orphan"
    )
    webhook: Mapped["WebhookConfig | None"] = relationship(
        back_populates="user", uselist=False, cascade="all, delete-orphan"
    )


# --------------------------------------------------------------------------- #
# Root of a content job
# --------------------------------------------------------------------------- #
class Project(TimestampMixin, Base):
    __tablename__ = "project"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    # Owner (nullable for pre-auth rows; new projects always set it). Queries are
    # owner-scoped so one account never sees another's projects.
    owner_id: Mapped[str | None] = mapped_column(
        ForeignKey("user.id"), nullable=True, index=True
    )
    website: Mapped[str] = mapped_column(String(255))
    topic: Mapped[str] = mapped_column(String(512))
    keyword: Mapped[str] = mapped_column(String(255))
    country: Mapped[str] = mapped_column(String(8), default="US")
    audience: Mapped[str | None] = mapped_column(String(512), nullable=True)
    tone: Mapped[str | None] = mapped_column(String(255), nullable=True)
    goal: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Pipeline stage: research | council | editor | ready | published
    stage: Mapped[str] = mapped_column(String(32), default="research")
    # Desired article format/type (e.g. "How-to", "Listicle", "Review") and target
    # body length in words — both steer the outline + draft prompts (null => model
    # decides). See app.pipeline.service._brief.
    article_type: Mapped[str | None] = mapped_column(String(64), nullable=True)
    word_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
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
    debate_turns: Mapped[list["DebateTurn"]] = relationship(
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
    runs: Mapped[list["Run"]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )
    owner: Mapped["User | None"] = relationship(back_populates="projects")


# --------------------------------------------------------------------------- #
# Durable pipeline run (decouples a run from the HTTP/SSE connection)
# --------------------------------------------------------------------------- #
class Run(TimestampMixin, Base):
    """One pipeline execution, tracked durably so a run outlives the connection
    that started it.

    The live SSE stream is a read-only *tail* of a run: the pipeline executes in
    a detached background worker that keeps going if the client disconnects, and
    a reconnect finds the active run (via :func:`status`) and re-attaches instead
    of starting a duplicate. On process restart, a startup reaper marks any still
    ``running`` row ``interrupted`` (the per-stage artifacts are already
    persisted, so the work is not lost).
    """

    __tablename__ = "run"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    project_id: Mapped[str] = mapped_column(ForeignKey("project.id"), index=True)

    # running | awaiting | done | error | interrupted
    status: Mapped[str] = mapped_column(String(16), default="running", index=True)
    stage: Mapped[str | None] = mapped_column(String(32), nullable=True)
    gated: Mapped[bool] = mapped_column(Boolean, default=False)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    project: Mapped["Project"] = relationship(back_populates="runs")


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
    # The Judge's final strategy summary — persisted so a paused/resumed run can
    # rebuild the outline from the approved council without re-running it.
    strategy: Mapped[str | None] = mapped_column(Text, nullable=True)

    project: Mapped["Project"] = relationship(back_populates="debates")


# --------------------------------------------------------------------------- #
# Threaded, replayable debate transcript (PRD §8.2)
# --------------------------------------------------------------------------- #
class DebateTurn(TimestampMixin, Base):
    """One utterance in the council debate — a replayable, threaded transcript.

    Where :class:`Debate` is a single flat blob of rebuttal strings, each turn is
    its own row so the UI can render the real back-and-forth in order, threaded by
    who is answering whom, and replay it after a page refresh. Round 1 holds each
    seat's opening position (``stance='open'``); later rounds hold the actual
    debate — a seat rebutting a specific rival (``rebut``) and that rival replying
    (``defend`` / ``concede`` / ``revise``); the Judge's deliberation is the final
    ``stance='verdict'`` turn.
    """

    __tablename__ = "debate_turn"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    project_id: Mapped[str] = mapped_column(ForeignKey("project.id"), index=True)

    round: Mapped[int] = mapped_column(Integer, default=1)
    # Global arrival order within one council run, so the transcript sorts stably.
    seq: Mapped[int] = mapped_column(Integer, default=0)
    seat_role: Mapped[str] = mapped_column(String(64))  # who spoke (or 'judge')
    provider: Mapped[str] = mapped_column(String(32), default="")
    model: Mapped[str] = mapped_column(String(128), default="")
    # The rival this turn is directed at (pairwise threading); None for openings.
    addressed_to: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # open | rebut | defend | concede | revise | reply | verdict
    stance: Mapped[str] = mapped_column(String(16), default="open")
    text: Mapped[str] = mapped_column(Text, default="")
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)

    project: Mapped["Project"] = relationship(back_populates="debate_turns")


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


# --------------------------------------------------------------------------- #
# Credit ledger (billing, PRD §13)
# --------------------------------------------------------------------------- #
class CreditLedger(TimestampMixin, Base):
    """Append-only credit movements. ``delta`` is signed: negative = a debit (a
    pipeline run), positive = a grant/top-up. ``balance_after`` snapshots the
    running balance for a cheap statement view."""

    __tablename__ = "credit_ledger"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(ForeignKey("user.id"), index=True)
    delta: Mapped[int] = mapped_column(Integer)
    balance_after: Mapped[int] = mapped_column(Integer, default=0)
    reason: Mapped[str] = mapped_column(String(32))  # signup | run | topup | refund
    project_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    detail: Mapped[str | None] = mapped_column(Text, nullable=True)

    user: Mapped["User"] = relationship(back_populates="ledger")


# --------------------------------------------------------------------------- #
# WordPress publish target (PRD §15) — one per user
# --------------------------------------------------------------------------- #
class WordPressConfig(TimestampMixin, Base):
    __tablename__ = "wordpress_config"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(ForeignKey("user.id"), unique=True, index=True)
    site_url: Mapped[str] = mapped_column(String(512))
    username: Mapped[str] = mapped_column(String(255))
    # WordPress *application* password (scoped + revocable). Stored server-side and
    # never returned to the browser. TODO: encrypt at rest for multi-tenant prod.
    app_password: Mapped[str] = mapped_column(Text)
    default_status: Mapped[str] = mapped_column(String(16), default="draft")  # draft | publish
    verified: Mapped[bool] = mapped_column(Boolean, default=False)

    user: Mapped["User"] = relationship(back_populates="wordpress")


# --------------------------------------------------------------------------- #
# Generic publish target (non-WordPress: custom / headless sites) — one per user
# --------------------------------------------------------------------------- #
class WebhookConfig(TimestampMixin, Base):
    """A user's custom publish endpoint for non-WordPress stacks.

    The finished article is POSTed as a stable JSON envelope (title, HTML,
    Markdown, meta) to ``endpoint_url`` with an optional ``Authorization: Bearer``
    token. Like the WP application password, ``auth_token`` is stored server-side
    and never returned to the browser."""

    __tablename__ = "webhook_config"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(ForeignKey("user.id"), unique=True, index=True)
    endpoint_url: Mapped[str] = mapped_column(String(1024))
    auth_token: Mapped[str | None] = mapped_column(Text, nullable=True)
    default_status: Mapped[str] = mapped_column(String(16), default="draft")  # draft | publish
    verified: Mapped[bool] = mapped_column(Boolean, default=False)

    user: Mapped["User"] = relationship(back_populates="webhook")
