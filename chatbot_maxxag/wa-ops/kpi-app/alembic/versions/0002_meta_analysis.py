"""casa_meta_analysis table + index on (account_id, conv_probability)

Revision ID: 0002
Revises: 0001
Create Date: 2026-04-22 10:00:00

"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | tuple[str, ...] | None = None
depends_on: str | tuple[str, ...] | None = None


def upgrade() -> None:
    op.create_table(
        "casa_meta_analysis",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("account_id", sa.Integer, nullable=False),
        sa.Column("run_at", sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
        sa.Column("conversations_analyzed", sa.Integer, nullable=False),
        sa.Column("period_start", sa.DateTime(timezone=True), nullable=False),
        sa.Column("period_end", sa.DateTime(timezone=True), nullable=False),
        sa.Column("summary", sa.Text, nullable=False),
        sa.Column("patterns", postgresql.JSONB, nullable=False),
        sa.Column("strengths", postgresql.JSONB, nullable=False),
        sa.Column("improvements", postgresql.JSONB, nullable=False),
        sa.Column("client_profile", sa.Text, nullable=False),
        sa.Column("claude_cost_usd", sa.Numeric(6, 4)),
        sa.Column("claude_tokens_in", sa.Integer),
        sa.Column("claude_tokens_out", sa.Integer),
    )
    op.create_index(
        "ix_casa_meta_account_run", "casa_meta_analysis",
        ["account_id", "run_at"],
        postgresql_ops={"run_at": "DESC"},
    )
    # Top/bottom conversions index (plan fix #12)
    op.create_index(
        "ix_analysis_account_conv", "analysis",
        ["account_id", "conv_probability"],
    )


def downgrade() -> None:
    op.drop_index("ix_analysis_account_conv", table_name="analysis")
    op.drop_index("ix_casa_meta_account_run", table_name="casa_meta_analysis")
    op.drop_table("casa_meta_analysis")
