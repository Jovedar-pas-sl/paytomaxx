"""init kpi schema — analysis, admin_user, alert

Revision ID: 0001
Revises:
Create Date: 2026-04-21 12:00:00

"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | tuple[str, ...] | None = None
depends_on: str | tuple[str, ...] | None = None


def upgrade() -> None:
    # ── analysis ─────────────────────────────────────────────────
    op.create_table(
        "analysis",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("conversation_id", sa.BigInteger, nullable=False, unique=True),
        sa.Column("account_id", sa.Integer, nullable=False),
        sa.Column("inbox_id", sa.Integer, nullable=False),
        sa.Column("analyzed_at", sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
        # Mood
        sa.Column("mood_label", sa.Text, nullable=False),
        sa.Column("mood_score", sa.SmallInteger, nullable=False),
        sa.Column("mood_reasoning", sa.Text),
        # Response times (ms)
        sa.Column("rt_p50", sa.Integer, nullable=False),
        sa.Column("rt_p90", sa.Integer, nullable=False),
        sa.Column("rt_max", sa.Integer, nullable=False),
        # Treatment (0-10 each)
        sa.Column("treat_carinoso", sa.SmallInteger, nullable=False),
        sa.Column("treat_profesional", sa.SmallInteger, nullable=False),
        sa.Column("treat_vendedor", sa.SmallInteger, nullable=False),
        sa.Column("treat_seco", sa.SmallInteger, nullable=False),
        # Conversion probability 0.00 - 1.00
        sa.Column("conv_probability", sa.Numeric(3, 2), nullable=False),
        # Red flags jsonb list
        sa.Column("red_flags", postgresql.JSONB, nullable=False,
                  server_default=sa.text("'[]'::jsonb")),
        # Cost meta
        sa.Column("claude_cost_usd", sa.Numeric(6, 4)),
        sa.Column("claude_tokens_in", sa.Integer),
        sa.Column("claude_tokens_out", sa.Integer),
        sa.CheckConstraint("mood_score BETWEEN 1 AND 10", name="ck_mood_score"),
        sa.CheckConstraint(
            "treat_carinoso BETWEEN 0 AND 10 "
            "AND treat_profesional BETWEEN 0 AND 10 "
            "AND treat_vendedor BETWEEN 0 AND 10 "
            "AND treat_seco BETWEEN 0 AND 10",
            name="ck_treat_ranges",
        ),
        sa.CheckConstraint("conv_probability BETWEEN 0 AND 1", name="ck_conv_prob"),
    )
    op.create_index("ix_analysis_account_analyzed", "analysis",
                    ["account_id", "analyzed_at"],
                    postgresql_using="btree",
                    postgresql_ops={"analyzed_at": "DESC"})
    op.create_index("ix_analysis_inbox_analyzed", "analysis",
                    ["inbox_id", "analyzed_at"],
                    postgresql_ops={"analyzed_at": "DESC"})
    op.create_index("ix_analysis_mood_label", "analysis", ["mood_label"])
    op.create_index(
        "ix_analysis_red_flags_gin", "analysis", ["red_flags"],
        postgresql_using="gin",
        postgresql_where=sa.text("red_flags != '[]'::jsonb"),
    )

    # ── admin_user ───────────────────────────────────────────────
    op.create_table(
        "admin_user",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("email", sa.Text, nullable=False, unique=True),
        sa.Column("password_hash", sa.Text, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
        sa.Column("last_login_at", sa.DateTime(timezone=True)),
    )

    # ── alert ────────────────────────────────────────────────────
    op.create_table(
        "alert",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("type", sa.Text, nullable=False),
        sa.Column("severity", sa.Text, nullable=False),
        sa.Column("conversation_id", sa.BigInteger),
        sa.Column("inbox_id", sa.Integer),
        sa.Column("message", sa.Text, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
        sa.Column("acknowledged_at", sa.DateTime(timezone=True)),
    )
    op.create_index(
        "ix_alert_unack_created", "alert", ["created_at"],
        postgresql_ops={"created_at": "DESC"},
        postgresql_where=sa.text("acknowledged_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_index("ix_alert_unack_created", table_name="alert")
    op.drop_table("alert")
    op.drop_table("admin_user")
    op.drop_index("ix_analysis_red_flags_gin", table_name="analysis")
    op.drop_index("ix_analysis_mood_label", table_name="analysis")
    op.drop_index("ix_analysis_inbox_analyzed", table_name="analysis")
    op.drop_index("ix_analysis_account_analyzed", table_name="analysis")
    op.drop_table("analysis")
