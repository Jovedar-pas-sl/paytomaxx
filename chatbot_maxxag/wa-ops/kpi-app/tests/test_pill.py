"""Unit tests for the pure agent status-pill resolver (inbox awareness).

Pure logic — no DB, no I/O. Asserts the priority rules: pause state always wins
over mode; paused_risk is the most prominent; mode decides only when active.
Mirrors the AAA / parametrize style used in test_auto_reply.py.
"""
from __future__ import annotations

import pytest

from app.agent.pill import resolve_pill


# ── Pause state beats everything ──────────────────────────────────────
@pytest.mark.parametrize("mode", ["off", "copilot", "auto", None])
def test_paused_risk_wins_over_any_mode(mode):
    pill = resolve_pill(mode, "paused_risk")
    assert pill.kind == "paused_risk"
    assert pill.prominent is True
    assert pill.label == "⏸ RIESGO"


@pytest.mark.parametrize("mode", ["off", "copilot", "auto", None])
def test_paused_human_wins_over_any_mode(mode):
    pill = resolve_pill(mode, "paused_human")
    assert pill.kind == "paused_human"
    assert pill.prominent is False
    assert pill.label == "HUMANO"


# ── Active + mode drives the pill ─────────────────────────────────────
@pytest.mark.parametrize("agent_status", [None, "active"])
def test_auto_mode_active_shows_auto(agent_status):
    pill = resolve_pill("auto", agent_status)
    assert pill.kind == "auto"
    assert pill.label == "AUTO"
    assert pill.prominent is False


@pytest.mark.parametrize("agent_status", [None, "active"])
def test_copilot_mode_active_shows_copilot(agent_status):
    pill = resolve_pill("copilot", agent_status)
    assert pill.kind == "copilot"
    assert pill.label == "COPILOTO"
    assert pill.prominent is False


@pytest.mark.parametrize("agent_status", [None, "active"])
def test_off_mode_active_shows_no_pill(agent_status):
    pill = resolve_pill("off", agent_status)
    assert pill.kind == "none"
    assert pill.label == ""
    assert pill.prominent is False


# ── Edge cases ────────────────────────────────────────────────────────
def test_null_mode_treated_as_off():
    """A NULL-joined wa_number (no number) coalesces to off → no pill."""
    pill = resolve_pill(None, None)
    assert pill.kind == "none"


def test_unknown_status_is_not_a_pause_falls_through_to_mode():
    """An unrecognised, non-pause status must not be treated as paused; mode
    decides as if active."""
    pill = resolve_pill("auto", "something_unexpected")
    # Not in the active set and not a known pause → resolver returns no pill.
    assert pill.kind == "none"


def test_only_paused_risk_is_prominent():
    """paused_risk is the single most-urgent state (the bot stopped attending)."""
    assert resolve_pill("auto", "paused_risk").prominent is True
    assert resolve_pill("auto", "paused_human").prominent is False
    assert resolve_pill("auto", "active").prominent is False
    assert resolve_pill("copilot", None).prominent is False
    assert resolve_pill("off", None).prominent is False
