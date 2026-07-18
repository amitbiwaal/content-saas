"""add debate_turn (threaded, replayable council debate transcript)

Revision ID: c3d4e5f60b21
Revises: b2c1f4e07a10
Create Date: 2026-07-14 19:10:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "c3d4e5f60b21"
down_revision: Union[str, None] = "b2c1f4e07a10"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "debate_turn",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("project_id", sa.String(length=36), nullable=False),
        sa.Column("round", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("seq", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("seat_role", sa.String(length=64), nullable=False),
        sa.Column("provider", sa.String(length=32), nullable=False, server_default=""),
        sa.Column("model", sa.String(length=128), nullable=False, server_default=""),
        sa.Column("addressed_to", sa.String(length=64), nullable=True),
        sa.Column("stance", sa.String(length=16), nullable=False, server_default="open"),
        sa.Column("text", sa.Text(), nullable=False, server_default=""),
        sa.Column("confidence", sa.Float(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["project_id"], ["project.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_debate_turn_project_id"), "debate_turn", ["project_id"], unique=False
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_debate_turn_project_id"), table_name="debate_turn")
    op.drop_table("debate_turn")
