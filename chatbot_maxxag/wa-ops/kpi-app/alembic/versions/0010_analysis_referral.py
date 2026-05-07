"""analysis.referral_source — track which channel/site brought the client

Adds a JSONB column to `analysis` storing the output of the referral skill
(see `app.analyzer.skills.detect_referral`). Used by the per-WA meta-analysis
to compute referral source distribution — which marketing channels actually
bring converting clients.

Revision ID: 0010
Revises: 0009
Create Date: 2026-05-07 10:00:00
"""
from __future__ import annotations

from alembic import op


revision: str = "0010"
down_revision: str | None = "0009"
branch_labels: str | tuple[str, ...] | None = None
depends_on: str | tuple[str, ...] | None = None


def upgrade() -> None:
    # Idempotent — safe to re-run.
    op.execute(
        "ALTER TABLE analysis ADD COLUMN IF NOT EXISTS referral JSONB"
    )

    # Partial index on the source_kind so per-WA aggregation is fast.
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS ix_analysis_referral_kind
        ON analysis ((referral->>'source_kind'))
        WHERE referral IS NOT NULL
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_analysis_referral_kind")
    op.execute("ALTER TABLE analysis DROP COLUMN IF EXISTS referral")
