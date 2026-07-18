"""add debate.strategy (persist Judge strategy for pause/resume)

Revision ID: d4e5f6071c32
Revises: c3d4e5f60b21
Create Date: 2026-07-14 19:40:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "d4e5f6071c32"
down_revision: Union[str, None] = "c3d4e5f60b21"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("debate", schema=None) as batch_op:
        batch_op.add_column(sa.Column("strategy", sa.Text(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("debate", schema=None) as batch_op:
        batch_op.drop_column("strategy")
