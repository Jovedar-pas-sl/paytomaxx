"""Pure resolver for the per-conversation agent status pill (inbox awareness).

Maps the wa_number agent `mode` + the conversation `agent_status` to a small,
template-friendly pill descriptor. Kept pure (no DB, no I/O) so the priority
rules can be unit-tested in isolation and reused by any render site.

Priority (highest first):
  1. paused_risk    — the bot HALTED on a safety guardrail (most prominent)
  2. paused_human   — a receptionist took over
  3. mode=auto + active  — bot is driving automatically
  4. mode=copilot + active — bot drafts, human sends
  5. mode=off (or anything else) — no pill (manual operation)

`agent_status` is the conversation pause state: NULL/'active' == not paused;
'paused_human'/'paused_risk' == paused. `mode` is 'off'/'copilot'/'auto'.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class PillState:
    """Template descriptor for the chat-list status pill.

    `kind` is a stable machine key the template branches on. `label` is the
    ES-ES text and `prominent` flags the single most-urgent state (paused_risk)
    so the template can pulse/colour it loudest. When `kind == 'none'` the
    template renders no pill at all.
    """
    kind: str            # 'paused_risk'|'paused_human'|'auto'|'copilot'|'none'
    label: str           # display text ('' when kind == 'none')
    prominent: bool      # True only for paused_risk (the bot stopped attending)


# Module-level singletons keep the resolver allocation-free and make equality
# checks in tests trivial.
_PILL_PAUSED_RISK = PillState("paused_risk", "⏸ RIESGO", True)
_PILL_PAUSED_HUMAN = PillState("paused_human", "HUMANO", False)
_PILL_AUTO = PillState("auto", "AUTO", False)
_PILL_COPILOT = PillState("copilot", "COPILOTO", False)
_PILL_NONE = PillState("none", "", False)

# agent_status values that mean "not paused" (NULL is also treated as active).
_ACTIVE_STATUSES = (None, "active")


def resolve_pill(mode: str | None, agent_status: str | None) -> PillState:
    """Resolve the pill for a conversation row.

    Pause state always wins over mode: a paused conversation shows why it is
    paused regardless of the configured mode. Only when the conversation is
    active does the mode decide between AUTO / COPILOTO / no pill.
    """
    if agent_status == "paused_risk":
        return _PILL_PAUSED_RISK
    if agent_status == "paused_human":
        return _PILL_PAUSED_HUMAN

    # Active (or unknown-but-not-a-pause) → mode drives the pill.
    if agent_status in _ACTIVE_STATUSES:
        if mode == "auto":
            return _PILL_AUTO
        if mode == "copilot":
            return _PILL_COPILOT
    # mode == 'off' (or anything unrecognised) → manual, no pill.
    return _PILL_NONE
