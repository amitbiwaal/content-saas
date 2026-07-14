"""add project.checkpoints (review-mode human approval state)

Revision ID: b2c1f4e07a10
Revises: a88a7a785659
Create Date: 2026-07-06 10:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "b2c1f4e07a10"
down_revision: Union[str, None] = "a88a7a785659"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Nullable JSON so existing rows default to NULL (= auto mode, no gate).
    with op.batch_alter_table("project", schema=None) as batch_op:
        batch_op.add_column(sa.Column("checkpoints", sa.JSON(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("project", schema=None) as batch_op:
        batch_op.drop_column("checkpoints")
