"""analysis + casa_meta_analysis get wa_number_id for per-WA history

Each row now remembers WHICH WhatsApp number it was analyzed for, so the
history view can filter by "casa + WA" and metrics can be rolled up per
WA independently.

Revision ID: 0006
Revises: 0005
Create Date: 2026-04-23 11:30:00
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision: str = "0006"
down_revision: str | None = "0005"
branch_labels: str | tuple[str, ...] | None = None
depends_on: str | tuple[str, ...] | None = None


def upgrade() -> None:
    # analysis.wa_number_id
    op.add_column(
        "analysis",
        sa.Column("wa_number_id", sa.Integer,
                  sa.ForeignKey("wa_number.id", ondelete="SET NULL"),
                  nullable=True),
    )
    op.create_index("ix_analysis_wa_analyzed", "analysis",
                    ["wa_number_id", "analyzed_at"],
                    postgresql_ops={"analyzed_at": "DESC"})

    # casa_meta_analysis.wa_number_id (nullable — meta can be per-casa or per-wa)
    op.add_column(
        "casa_meta_analysis",
        sa.Column("wa_number_id", sa.Integer,
                  sa.ForeignKey("wa_number.id", ondelete="SET NULL"),
                  nullable=True),
    )
    op.create_index("ix_meta_wa_run", "casa_meta_analysis",
                    ["wa_number_id", "run_at"],
                    postgresql_ops={"run_at": "DESC"})

    # Backfill from conversation → wa_number_id
    op.execute("""
        UPDATE analysis a
        SET wa_number_id = c.wa_number_id
        FROM conversation c
        WHERE c.id = a.conversation_id AND a.wa_number_id IS NULL
    """)


def downgrade() -> None:
    op.drop_index("ix_meta_wa_run", table_name="casa_meta_analysis")
    op.drop_column("casa_meta_analysis", "wa_number_id")
    op.drop_index("ix_analysis_wa_analyzed", table_name="analysis")
    op.drop_column("analysis", "wa_number_id")
