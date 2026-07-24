"""add research.keywords + research.competitors + draft.seo

The redesigned pipeline splits Research into a keyword-research stage and a real
competitor-analysis stage (fetched top-ranking pages), and adds an SEO-polish
stage that produces meta title/description/slug/takeaways for the draft.

Revision ID: f7b3c4d5e6a8
Revises: e2a6b7c8d9f0
Create Date: 2026-07-24 10:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "f7b3c4d5e6a8"
down_revision: Union[str, None] = "e2a6b7c8d9f0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("research", schema=None) as batch_op:
        batch_op.add_column(sa.Column("keywords", sa.JSON(), nullable=True))
        batch_op.add_column(sa.Column("competitors", sa.JSON(), nullable=True))
    with op.batch_alter_table("draft", schema=None) as batch_op:
        batch_op.add_column(sa.Column("seo", sa.JSON(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("draft", schema=None) as batch_op:
        batch_op.drop_column("seo")
    with op.batch_alter_table("research", schema=None) as batch_op:
        batch_op.drop_column("competitors")
        batch_op.drop_column("keywords")
