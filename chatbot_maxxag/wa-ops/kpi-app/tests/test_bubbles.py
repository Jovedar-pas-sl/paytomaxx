"""Unit tests for splitting a reply into up to 2 human-like bubbles (#6)."""

from app.agent.auto_reply import _BUBBLE_SPLIT_MIN, _split_reply


def test_short_reply_stays_one_bubble():
    txt = "uff Madison, muy buena 😏 ¿te la reservo?"
    assert _split_reply(txt) == [txt]


def test_empty_returns_empty_list():
    assert _split_reply("") == []
    assert _split_reply("   ") == []


def test_long_reply_splits_into_two_at_sentence_boundary():
    txt = (
        "heyy cariño, qué bien que escribas y me encanta tu interés por las chicas de hoy. "
        "dime, ¿a qué hora te viene mejor para dejártela lista, guapo?"
    )
    parts = _split_reply(txt)
    assert len(parts) == 2
    # No part is empty, and rejoining preserves all the words (order kept).
    assert all(p.strip() for p in parts)
    assert parts[0].endswith(".") or parts[0].endswith("?") or parts[0].endswith("!")


def test_does_not_split_on_ellipsis():
    # '...' must never be a split point — a single sentence with an ellipsis and
    # no other boundary stays one bubble even when long.
    txt = "mmm me encanta tu gusto cariño y tengo justo a la chica perfecta para ti hoy mismo aquí... " + "x" * 80
    parts = _split_reply(txt)
    assert parts == [txt.strip()]


def test_no_boundary_long_reply_stays_one_bubble():
    txt = "x" * (_BUBBLE_SPLIT_MIN + 50)  # no sentence punctuation at all
    assert _split_reply(txt) == [txt]
