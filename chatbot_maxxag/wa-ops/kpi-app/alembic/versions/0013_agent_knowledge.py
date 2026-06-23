"""agent knowledge base — casa_profile + girl

F0 of the WhatsApp agent (see docs/SPEC-AGENT-WHATSAPP.md). Brings the per-casa
knowledge that today lives in the WordPress plugin JSON (config.json / girls.json)
into wa-ops as the single source of truth shared by the web widget and the
WhatsApp agent.

  * casa_profile (1:1 casa): bot persona, rates, schedule, address+geo, FAQs and
    outcall pricing (base price + taxi tariff + surcharge %).
  * girl (N per casa): escort profiles, mirrors girls.json fields. ext_id keeps the
    plugin id so a later sync can dedup against the WordPress source.

No code path reads these tables yet — F1 (reply_engine) and the panel editor land
in follow-up PRs. This migration only creates the schema.

Revision ID: 0013
Revises: 0012
Create Date: 2026-06-15 12:00:00
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "0013"
down_revision: str | None = "0012"
branch_labels: str | tuple[str, ...] | None = None
depends_on: str | tuple[str, ...] | None = None


def upgrade() -> None:
    # ── casa_profile (1:1 casa) ──────────────────────────────────
    op.create_table(
        "casa_profile",
        sa.Column(
            "casa_id",
            sa.Integer,
            sa.ForeignKey("casa.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("bot_name", sa.Text),
        sa.Column("default_lang", sa.Text, nullable=False,
                  server_default=sa.text("'es'")),
        sa.Column("whatsapp_recepcion", sa.Text),
        sa.Column("telegram_recepcion", sa.Text),
        # greetings/rates/schedule/faqs mirror config.json shape; outcall holds
        # base price + taxi tariff + surcharge % (see spec §8).
        sa.Column("greetings", postgresql.JSONB,
                  server_default=sa.text("'{}'::jsonb")),
        sa.Column("rates", postgresql.JSONB,
                  server_default=sa.text("'{}'::jsonb")),
        sa.Column("schedule", postgresql.JSONB,
                  server_default=sa.text("'{}'::jsonb")),
        sa.Column("faqs", postgresql.JSONB,
                  server_default=sa.text("'[]'::jsonb")),
        sa.Column("outcall", postgresql.JSONB,
                  server_default=sa.text("'{}'::jsonb")),
        sa.Column("address", sa.Text),
        sa.Column("address_lat", sa.Float),
        sa.Column("address_lng", sa.Float),
        sa.Column("maps_url", sa.Text),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
    )

    # ── girl (N per casa) ────────────────────────────────────────
    op.create_table(
        "girl",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("casa_id", sa.Integer,
                  sa.ForeignKey("casa.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("ext_id", sa.Text),  # plugin id (e.g. 'vlc1', '51a34c7d')
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("age", sa.Integer),
        sa.Column("nationality", sa.Text),
        sa.Column("description", sa.Text),
        sa.Column("photo_url", sa.Text),
        sa.Column("whatsapp", sa.Text),
        sa.Column("available_today", sa.Boolean, nullable=False,
                  server_default=sa.text("true")),
        sa.Column("outcall", sa.Boolean, nullable=False,
                  server_default=sa.text("false")),
        sa.Column("escort_pareja", sa.Boolean, nullable=False,
                  server_default=sa.text("false")),
        sa.Column("services", postgresql.JSONB,
                  server_default=sa.text("'[]'::jsonb")),
        sa.Column("languages", postgresql.JSONB,
                  server_default=sa.text("'[]'::jsonb")),
        sa.Column("active", sa.Boolean, nullable=False,
                  server_default=sa.text("true")),
        sa.Column("sort_order", sa.Integer, nullable=False,
                  server_default=sa.text("0")),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
    )
    # one plugin row per casa (ext_id may be NULL for manually-added girls)
    op.create_index(
        "uq_girl_casa_ext", "girl", ["casa_id", "ext_id"],
        unique=True, postgresql_where=sa.text("ext_id IS NOT NULL"),
    )
    # hot path: list girls available today for a casa (reply_engine context)
    op.create_index(
        "ix_girl_casa_available", "girl", ["casa_id", "available_today"],
    )


def downgrade() -> None:
    op.drop_index("ix_girl_casa_available", table_name="girl")
    op.drop_index("uq_girl_casa_ext", table_name="girl")
    op.drop_table("girl")
    op.drop_table("casa_profile")
