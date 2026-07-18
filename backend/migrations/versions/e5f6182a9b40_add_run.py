"""add run (durable pipeline run, decoupled from the SSE connection)

Revision ID: e5f6182a9b40
Revises: d4e5f6071c32
Create Date: 2026-07-16 12:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "e5f6182a9b40"
down_revision: Union[str, None] = "d4e5f6071c32"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "run",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("project_id", sa.String(length=36), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False, server_default="running"),
        sa.Column("stage", sa.String(length=32), nullable=True),
        sa.Column("gated", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("finished_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["project_id"], ["project.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_run_project_id"), "run", ["project_id"], unique=False)
    op.create_index(op.f("ix_run_status"), "run", ["status"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_run_status"), table_name="run")
    op.drop_index(op.f("ix_run_project_id"), table_name="run")
    op.drop_table("run")
