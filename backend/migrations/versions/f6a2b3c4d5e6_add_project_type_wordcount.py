"""add project.article_type + project.word_count (brief: format + target length)

Revision ID: f6a2b3c4d5e6
Revises: e5f6182a9b40
Create Date: 2026-07-16 13:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "f6a2b3c4d5e6"
down_revision: Union[str, None] = "e5f6182a9b40"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("project", schema=None) as batch_op:
        batch_op.add_column(sa.Column("article_type", sa.String(length=64), nullable=True))
        batch_op.add_column(sa.Column("word_count", sa.Integer(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("project", schema=None) as batch_op:
        batch_op.drop_column("word_count")
        batch_op.drop_column("article_type")
