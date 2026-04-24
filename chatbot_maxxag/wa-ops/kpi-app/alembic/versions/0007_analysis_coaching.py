"""analysis.coaching JSONB — actionable per-conversation advice

Stores the 6th skill's output: overall, went_well, missed_opportunities,
response_tips, tone_tips, example_reply. Nullable so old rows stay valid.

Revision ID: 0007
Revises: 0006
Create Date: 2026-04-23 12:00:00
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "0007"
down_revision: str | None = "0006"
branch_labels: str | tuple[str, ...] | None = None
depends_on: str | tuple[str, ...] | None = None


def upgrade() -> None:
    op.add_column(
        "analysis",
        sa.Column("coaching", postgresql.JSONB, nullable=True),
    )


def downgrade() -> None:
    op.drop_column("analysis", "coaching")
