"""add webhook_config (generic non-WordPress publish target)

Revision ID: e2a6b7c8d9f0
Revises: d1f5a2b30c47
Create Date: 2026-07-18 14:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "e2a6b7c8d9f0"
down_revision: Union[str, None] = "d1f5a2b30c47"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "webhook_config",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("endpoint_url", sa.String(length=1024), nullable=False),
        sa.Column("auth_token", sa.Text(), nullable=True),
        sa.Column("default_status", sa.String(length=16), nullable=False, server_default="draft"),
        sa.Column("verified", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", name="uq_webhook_user"),
    )
    op.create_index(op.f("ix_webhook_config_user_id"), "webhook_config", ["user_id"], unique=True)


def downgrade() -> None:
    op.drop_index(op.f("ix_webhook_config_user_id"), table_name="webhook_config")
    op.drop_table("webhook_config")
