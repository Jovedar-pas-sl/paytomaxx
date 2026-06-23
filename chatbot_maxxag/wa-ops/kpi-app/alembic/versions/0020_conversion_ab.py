"""conversation outcome (conversion) + A/B greeting variant (Wave 3).

  * conversation.outcome             TEXT NULL  — 'reservado' when the receptionist
                                                  marks the conversation as closed/booked
                                                  (the conversion signal); NULL otherwise.
  * conversation.outcome_at          TIMESTAMPTZ NULL — when it was marked.
  * conversation.outcome_by_user_id  INT NULL    — who marked it (admin_user.id).
  * conversation.ab_variant          TEXT NULL   — greeting A/B bucket assigned on
                                                   the first auto-reply ('directa' |
                                                   'coqueta' | 'curiosa'); NULL = not in test.

All columns nullable, no backfill, no CONCURRENTLY — atomic add.

Revision ID: 0020
Revises: 0019
Create Date: 2026-06-19 12:30:00
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision: str = "0020"
down_revision: str | None = "0019"
branch_labels: str | tuple[str, ...] | None = None
depends_on: str | tuple[str, ...] | None = None


def upgrade() -> None:
    op.add_column("conversation", sa.Column("outcome", sa.Text(), nullable=True))
    op.add_column(
        "conversation",
        sa.Column("outcome_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "conversation", sa.Column("outcome_by_user_id", sa.Integer(), nullable=True)
    )
    op.add_column("conversation", sa.Column("ab_variant", sa.Text(), nullable=True))
    # Conversion + A/B readouts scan by these two; a small partial index keeps the
    # aggregate cheap without bloating the hot conversation row.
    op.create_index(
        "ix_conversation_ab_variant",
        "conversation",
        ["ab_variant"],
        postgresql_where=sa.text("ab_variant IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("ix_conversation_ab_variant", table_name="conversation")
    op.drop_column("conversation", "ab_variant")
    op.drop_column("conversation", "outcome_by_user_id")
    op.drop_column("conversation", "outcome_at")
    op.drop_column("conversation", "outcome")
