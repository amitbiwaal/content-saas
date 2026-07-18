"""add user, credit_ledger, wordpress_config + project.owner_id (auth + billing + WP)

Revision ID: a7b8c9d0e1f2
Revises: f6a2b3c4d5e6
Create Date: 2026-07-16 14:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "a7b8c9d0e1f2"
down_revision: Union[str, None] = "f6a2b3c4d5e6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "user",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("email", sa.String(length=320), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=True),
        sa.Column("password_hash", sa.String(length=255), nullable=True),
        sa.Column("google_sub", sa.String(length=64), nullable=True),
        sa.Column("credits", sa.Integer(), nullable=False, server_default="500"),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_user_email"), "user", ["email"], unique=True)
    op.create_index(op.f("ix_user_google_sub"), "user", ["google_sub"], unique=False)

    op.create_table(
        "credit_ledger",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("delta", sa.Integer(), nullable=False),
        sa.Column("balance_after", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("reason", sa.String(length=32), nullable=False),
        sa.Column("project_id", sa.String(length=36), nullable=True),
        sa.Column("detail", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_credit_ledger_user_id"), "credit_ledger", ["user_id"], unique=False)
    op.create_index(op.f("ix_credit_ledger_project_id"), "credit_ledger", ["project_id"], unique=False)

    op.create_table(
        "wordpress_config",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("site_url", sa.String(length=512), nullable=False),
        sa.Column("username", sa.String(length=255), nullable=False),
        sa.Column("app_password", sa.Text(), nullable=False),
        sa.Column("default_status", sa.String(length=16), nullable=False, server_default="draft"),
        sa.Column("verified", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", name="uq_wordpress_user"),
    )
    op.create_index(op.f("ix_wordpress_config_user_id"), "wordpress_config", ["user_id"], unique=True)

    with op.batch_alter_table("project", schema=None) as batch_op:
        batch_op.add_column(sa.Column("owner_id", sa.String(length=36), nullable=True))
        batch_op.create_index(op.f("ix_project_owner_id"), ["owner_id"], unique=False)
        batch_op.create_foreign_key("fk_project_owner", "user", ["owner_id"], ["id"])


def downgrade() -> None:
    with op.batch_alter_table("project", schema=None) as batch_op:
        batch_op.drop_constraint("fk_project_owner", type_="foreignkey")
        batch_op.drop_index(op.f("ix_project_owner_id"))
        batch_op.drop_column("owner_id")
    op.drop_index(op.f("ix_wordpress_config_user_id"), table_name="wordpress_config")
    op.drop_table("wordpress_config")
    op.drop_index(op.f("ix_credit_ledger_project_id"), table_name="credit_ledger")
    op.drop_index(op.f("ix_credit_ledger_user_id"), table_name="credit_ledger")
    op.drop_table("credit_ledger")
    op.drop_index(op.f("ix_user_google_sub"), table_name="user")
    op.drop_index(op.f("ix_user_email"), table_name="user")
    op.drop_table("user")
