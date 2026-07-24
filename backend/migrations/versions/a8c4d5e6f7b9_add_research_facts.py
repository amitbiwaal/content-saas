"""add research.facts — the evidence bank extracted from fetched competitor pages

Revision ID: a8c4d5e6f7b9
Revises: f7b3c4d5e6a8
Create Date: 2026-07-25 12:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "a8c4d5e6f7b9"
down_revision: Union[str, None] = "f7b3c4d5e6a8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("research", schema=None) as batch_op:
        batch_op.add_column(sa.Column("facts", sa.JSON(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("research", schema=None) as batch_op:
        batch_op.drop_column("facts")
