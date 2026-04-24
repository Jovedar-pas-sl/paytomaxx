"""own inbox tables — casa, contact, conversation, message

Replaces the read-only Chatwoot DB integration. KPI app now owns the
full inbox: messages ingested via WAHA webhooks land directly here.

Revision ID: 0003
Revises: 0002
Create Date: 2026-04-22 14:00:00

"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | tuple[str, ...] | None = None
depends_on: str | tuple[str, ...] | None = None


def upgrade() -> None:
    # ── casa (1 per WAHA session) ─────────────────────────────────
    op.create_table(
        "casa",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("waha_session", sa.Text, nullable=False, unique=True),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
    )

    # ── contact (WA JID + name) ───────────────────────────────────
    op.create_table(
        "contact",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("waha_jid", sa.Text, nullable=False, unique=True),
        sa.Column("name", sa.Text),
        sa.Column("phone", sa.Text),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
    )

    # ── conversation (1 per casa × contact) ───────────────────────
    op.create_table(
        "conversation",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("casa_id", sa.Integer, sa.ForeignKey("casa.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("contact_id", sa.BigInteger, sa.ForeignKey("contact.id"),
                  nullable=False),
        sa.Column("status", sa.Text, nullable=False,
                  server_default=sa.text("'open'")),
        sa.Column("last_message_at", sa.DateTime(timezone=True)),
        sa.Column("unread_count", sa.Integer, nullable=False,
                  server_default=sa.text("0")),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
        sa.UniqueConstraint("casa_id", "contact_id", name="uq_conv_casa_contact"),
        sa.CheckConstraint("status IN ('open','resolved','pending')", name="ck_conv_status"),
    )
    op.create_index(
        "ix_conversation_casa_last", "conversation",
        ["casa_id", "last_message_at"],
        postgresql_ops={"last_message_at": "DESC NULLS LAST"},
    )
    op.create_index("ix_conversation_status", "conversation", ["status"])

    # ── message (inbound + outbound) ──────────────────────────────
    op.create_table(
        "message",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("conversation_id", sa.BigInteger,
                  sa.ForeignKey("conversation.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("waha_msg_id", sa.Text, unique=True),  # dedup
        sa.Column("direction", sa.Text, nullable=False),  # in | out
        sa.Column("body", sa.Text),
        sa.Column("media_url", sa.Text),
        sa.Column("media_mime", sa.Text),
        sa.Column("ack", sa.SmallInteger, nullable=False,
                  server_default=sa.text("0")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("direction IN ('in','out')", name="ck_msg_direction"),
    )
    op.create_index(
        "ix_message_conv_created", "message",
        ["conversation_id", "created_at"],
    )
    # Hourly aggregate index for heatmap
    op.create_index(
        "ix_message_created", "message",
        ["created_at"],
        postgresql_ops={"created_at": "DESC"},
    )


def downgrade() -> None:
    op.drop_index("ix_message_created", table_name="message")
    op.drop_index("ix_message_conv_created", table_name="message")
    op.drop_table("message")
    op.drop_index("ix_conversation_status", table_name="conversation")
    op.drop_index("ix_conversation_casa_last", table_name="conversation")
    op.drop_table("conversation")
    op.drop_table("contact")
    op.drop_table("casa")
