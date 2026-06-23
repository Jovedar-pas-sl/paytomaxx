"""agent runtime — per-number mode + per-conversation pause + agent-sent flag

F2 of the WhatsApp agent (see docs/SPEC-AGENT-WHATSAPP.md). Wires the F1 reply
engine into the webhook → worker flow. This migration only adds the runtime
state the auto-reply job and its enqueue gate read/write:

  * wa_number.mode TEXT NOT NULL DEFAULT 'off' — per-number agent mode. Values
    off|auto|copilot. Default 'off' means the system stays inert until a number
    is explicitly enabled (no reply path fires for any existing row).
  * conversation.agent_status TEXT (nullable, NULL == active) — pause state.
    Values when set: paused_human (receptionist took over) | paused_risk
    (guardrail tripped). Kept TEXT+nullable (not an enum) so future states are
    additive without a migration. agent_paused_at records when it paused.
  * message.agent_generated BOOLEAN NOT NULL DEFAULT false — distinguishes a bot
    send from a human (receptionist) send; drives has_recent_human_outbound().

All columns carry a non-null server_default so existing rows backfill atomically
on add (no op.execute UPDATE, no CONCURRENTLY, no autocommit_block needed). One
hot-path index supports has_recent_human_outbound().

Revision ID: 0014
Revises: 0013
Create Date: 2026-06-15 18:00:00
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision: str = "0014"
down_revision: str | None = "0013"
branch_labels: str | tuple[str, ...] | None = None
depends_on: str | tuple[str, ...] | None = None


def upgrade() -> None:
    # ── wa_number.mode (off|auto|copilot, default off → inert) ───────
    op.add_column(
        "wa_number",
        sa.Column("mode", sa.Text, nullable=False,
                  server_default=sa.text("'off'")),
    )
    op.create_check_constraint(
        "ck_wa_number_mode", "wa_number",
        "mode IN ('off','auto','copilot')",
    )

    # ── conversation.agent_status (NULL == active) + agent_paused_at ─
    op.add_column(
        "conversation",
        sa.Column("agent_status", sa.Text, nullable=True),
    )
    op.add_column(
        "conversation",
        sa.Column("agent_paused_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_check_constraint(
        "ck_conversation_agent_status", "conversation",
        "agent_status IS NULL OR agent_status IN ('active','paused_human','paused_risk')",
    )

    # ── message.agent_generated (bot vs human send) ──────────────────
    op.add_column(
        "message",
        sa.Column("agent_generated", sa.Boolean, nullable=False,
                  server_default=sa.text("false")),
    )
    # hot path for has_recent_human_outbound(): filter by conversation +
    # human (agent_generated=false) outbound within a recent window.
    op.create_index(
        "ix_message_conv_agent_created", "message",
        ["conversation_id", "agent_generated", "created_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_message_conv_agent_created", table_name="message")
    op.drop_column("message", "agent_generated")
    op.drop_constraint("ck_conversation_agent_status", "conversation", type_="check")
    op.drop_column("conversation", "agent_paused_at")
    op.drop_column("conversation", "agent_status")
    op.drop_constraint("ck_wa_number_mode", "wa_number", type_="check")
    op.drop_column("wa_number", "mode")
