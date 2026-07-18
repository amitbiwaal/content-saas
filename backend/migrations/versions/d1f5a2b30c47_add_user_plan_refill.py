"""add user.plan + user.credits_refilled_at (monthly credit refill)

Revision ID: d1f5a2b30c47
Revises: c9e4f0a21b36
Create Date: 2026-07-18 12:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "d1f5a2b30c47"
down_revision: Union[str, None] = "c9e4f0a21b36"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("user", schema=None) as batch_op:
        batch_op.add_column(
            sa.Column("plan", sa.String(length=16), nullable=False, server_default="free")
        )
        batch_op.add_column(sa.Column("credits_refilled_at", sa.DateTime(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("user", schema=None) as batch_op:
        batch_op.drop_column("credits_refilled_at")
        batch_op.drop_column("plan")
