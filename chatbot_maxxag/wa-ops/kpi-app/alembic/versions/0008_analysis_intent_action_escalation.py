"""analysis.intent / next_action / escalation columns — 3 new skills

Adds three JSONB columns to persist the output of the new analyzer skills:

  - intent        — IntentResult (primary, secondary, confidence, reasoning)
  - next_action   — NextActionResult (action, urgency, suggested_message, why)
  - escalation    — EscalationResult (should_escalate, severity, reason, triggers)

All nullable so pre-existing rows remain valid; the worker fills them on
the next analysis run. Also indexes `should_escalate` for the future
"needs human" queue view.

Revision ID: 0008
Revises: 0007
Create Date: 2026-04-24 10:00:00
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "0008"
down_revision: str | None = "0007"
branch_labels: str | tuple[str, ...] | None = None
depends_on: str | tuple[str, ...] | None = None


def upgrade() -> None:
    op.add_column(
        "analysis",
        sa.Column("intent", postgresql.JSONB, nullable=True),
    )
    op.add_column(
        "analysis",
        sa.Column("next_action", postgresql.JSONB, nullable=True),
    )
    op.add_column(
        "analysis",
        sa.Column("escalation", postgresql.JSONB, nullable=True),
    )

    # Partial index on escalation rows so /alerts?type=escalation is fast.
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS ix_analysis_should_escalate
        ON analysis ((escalation->>'should_escalate'))
        WHERE escalation IS NOT NULL
          AND (escalation->>'should_escalate')::boolean = true
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_analysis_should_escalate")
    op.drop_column("analysis", "escalation")
    op.drop_column("analysis", "next_action")
    op.drop_column("analysis", "intent")
