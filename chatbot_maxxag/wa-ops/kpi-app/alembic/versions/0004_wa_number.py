"""wa_number table — casa 1:N WhatsApp sessions

Each casa can own multiple WhatsApp numbers (oficial, secundario, etc).
Conversations link to a specific wa_number (not just the casa) so the
same contact writing to two different WAs of the same casa produces
two separate conversations.

Revision ID: 0004
Revises: 0003
Create Date: 2026-04-23 10:00:00

"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision: str = "0004"
down_revision: str | None = "0003"
branch_labels: str | tuple[str, ...] | None = None
depends_on: str | tuple[str, ...] | None = None


def upgrade() -> None:
    # ── wa_number ────────────────────────────────────────────────
    op.create_table(
        "wa_number",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("casa_id", sa.Integer,
                  sa.ForeignKey("casa.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("session", sa.Text, nullable=False, unique=True),
        sa.Column("label", sa.Text, nullable=False,
                  server_default=sa.text("'Oficial'")),
        sa.Column("phone", sa.Text),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
    )
    op.create_index("ix_wa_number_casa", "wa_number", ["casa_id"])

    # ── conversation.wa_number_id (nullable for data migration) ──
    op.add_column(
        "conversation",
        sa.Column("wa_number_id", sa.Integer,
                  sa.ForeignKey("wa_number.id", ondelete="SET NULL"),
                  nullable=True),
    )

    # ── Data migration ───────────────────────────────────────────
    # 1. Seed wa_number from casa.waha_session (one row per casa)
    op.execute("""
        INSERT INTO wa_number (casa_id, session, label)
        SELECT id, waha_session, 'Oficial'
        FROM casa
        WHERE waha_session IS NOT NULL
        ON CONFLICT (session) DO NOTHING
    """)

    # 2. Backfill conversation.wa_number_id via casa_id lookup
    op.execute("""
        UPDATE conversation c
        SET wa_number_id = wn.id
        FROM wa_number wn
        WHERE wn.casa_id = c.casa_id
    """)

    # ── Replace unique constraint ────────────────────────────────
    op.drop_constraint("uq_conv_casa_contact", "conversation", type_="unique")
    op.create_unique_constraint(
        "uq_conv_wa_contact", "conversation",
        ["wa_number_id", "contact_id"],
    )

    # Note: we leave `casa.waha_session` column for now (legacy read support);
    # a future migration (0005) will drop it once all code paths use wa_number.


def downgrade() -> None:
    op.drop_constraint("uq_conv_wa_contact", "conversation", type_="unique")
    op.create_unique_constraint(
        "uq_conv_casa_contact", "conversation",
        ["casa_id", "contact_id"],
    )
    op.drop_column("conversation", "wa_number_id")
    op.drop_index("ix_wa_number_casa", table_name="wa_number")
    op.drop_table("wa_number")
