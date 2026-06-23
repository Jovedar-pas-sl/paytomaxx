"""agent follow-up of abandoned quotes — the max-1 marker / atomic claim column

When, on an AUTO-mode number, Sara quoted a concrete price/offer and the client
then went silent, a single warm re-engagement nudge may be sent ONCE per
conversation EVER. That "already followed up" state needs one persisted marker,
which doubles as the race-safe atomic claim:

  * conversation.agent_followup_at TIMESTAMPTZ NULL — NULL == no follow-up sent
    yet (mirrors how agent_status NULL == active and agent_paused_at NULL == not
    paused). The send job stamps it now() via a conditional UPDATE
    (... WHERE id=$1 AND agent_followup_at IS NULL RETURNING id), so two racing
    jobs can never both send — exactly the "claim-then-act" idiom used by
    ack_alert. Set BEFORE the WAHA send, so a crash mid-send still consumes the
    one allowed touch (we never risk a duplicate nudge).

A nullable timestamptz column with NO server default is atomic on add and needs
no backfill — no op.execute UPDATE, no CONCURRENTLY, no autocommit_block needed
(mirrors 0014's agent_paused_at).

No index is added: the candidate query is bounded by `last_message_at`
(already covered by ix_conversation_casa_last) and narrowed by
`agent_followup_at IS NULL`; the per-conversation set after the time + mode +
status filters is tiny, so a dedicated index would not pay for itself and a
partial index WHERE agent_followup_at IS NULL would require CONCURRENTLY +
autocommit_block. Kept deliberately additive and cheap.

Revision ID: 0016
Revises: 0015
Create Date: 2026-06-16 12:00:00
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision: str = "0016"
down_revision: str | None = "0015"
branch_labels: str | tuple[str, ...] | None = None
depends_on: str | tuple[str, ...] | None = None


def upgrade() -> None:
    # ── conversation.agent_followup_at (NULL == not followed up yet) ──
    # Atomic add (nullable, no server_default) — see module docstring.
    op.add_column(
        "conversation",
        sa.Column("agent_followup_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("conversation", "agent_followup_at")
