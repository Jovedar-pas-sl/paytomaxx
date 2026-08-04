"""Keyset (cursor) pagination for the inbox conversation list.

Covers the cursor derivation in queries.list_conversations_page (has-more via the
+1 sentinel row, next-cursor = last KEPT row) and the widget's cursor parsing.
Pure unit tests — list_conversations is monkeypatched, so no DB is needed.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app import queries
from app.queries import ConversationRow
from app.routes.widgets import _parse_cursor_ts


def _row(id: int, ts: datetime) -> ConversationRow:
    return ConversationRow(
        id=id, account_id=1, account_name="Casa", inbox_id=1, inbox_name="Casa",
        contact_name=f"c{id}", contact_phone=None, status="open", message_count=0,
        last_message_at=ts, last_message_preview="", mood_label=None, mood_score=None,
        conv_probability=None, unread_count=0, wa_number_id=None, wa_label=None,
    )


# ── _parse_cursor_ts (widget) ────────────────────────────────────────
def test_parse_cursor_ts_roundtrips_isoformat():
    ts = datetime(2026, 7, 2, 15, 30, 45, tzinfo=timezone.utc)
    assert _parse_cursor_ts(ts.isoformat()) == ts


def test_parse_cursor_ts_empty_or_garbage_is_none():
    assert _parse_cursor_ts("") is None
    assert _parse_cursor_ts("not-a-date") is None


# ── list_conversations_page: has-more + next cursor ──────────────────
async def test_page_requests_limit_plus_one_keyset_no_total(monkeypatch):
    """The page fetch asks for limit+1 rows, in keyset/recent mode, with no count."""
    seen = {}

    async def fake_list(pool, **kw):
        seen.update(kw)
        return [], 0

    monkeypatch.setattr(queries, "list_conversations", fake_list)
    await queries.list_conversations_page(object(), casa_id=1, limit=50)
    assert seen["limit"] == 51
    assert seen["order"] == "recent"
    assert seen["include_total"] is False


async def test_page_has_more_cursor_is_last_kept_row(monkeypatch):
    base = datetime(2026, 7, 2, 12, 0, tzinfo=timezone.utc)
    # limit=2 → asks for 3; getting 3 means there's a next page. Keep 2; the cursor
    # is the 2nd (last KEPT) row, NOT the discarded 3rd.
    returned = [
        _row(10, base),
        _row(9, base - timedelta(minutes=1)),
        _row(8, base - timedelta(minutes=2)),
    ]

    async def fake_list(pool, **kw):
        return returned, 0

    monkeypatch.setattr(queries, "list_conversations", fake_list)
    rows, next_ts, next_id = await queries.list_conversations_page(
        object(), casa_id=1, limit=2
    )
    assert [r.id for r in rows] == [10, 9]
    assert next_ts == base - timedelta(minutes=1)
    assert next_id == 9


async def test_page_last_page_returns_no_cursor(monkeypatch):
    base = datetime(2026, 7, 2, 12, 0, tzinfo=timezone.utc)
    # Exactly `limit` rows come back (no +1) → this is the last page.
    returned = [_row(10, base), _row(9, base - timedelta(minutes=1))]

    async def fake_list(pool, **kw):
        return returned, 0

    monkeypatch.setattr(queries, "list_conversations", fake_list)
    rows, next_ts, next_id = await queries.list_conversations_page(
        object(), casa_id=1, limit=2
    )
    assert [r.id for r in rows] == [10, 9]
    assert next_ts is None and next_id is None


async def test_page_empty_returns_no_cursor(monkeypatch):
    async def fake_list(pool, **kw):
        return [], 0

    monkeypatch.setattr(queries, "list_conversations", fake_list)
    rows, next_ts, next_id = await queries.list_conversations_page(
        object(), casa_id=1, limit=2
    )
    assert rows == [] and next_ts is None and next_id is None


async def test_page_cursor_forwarded_to_query(monkeypatch):
    """A cursor passed to the page is forwarded verbatim to list_conversations."""
    base = datetime(2026, 7, 2, 12, 0, tzinfo=timezone.utc)
    seen = {}

    async def fake_list(pool, **kw):
        seen.update(kw)
        return [], 0

    monkeypatch.setattr(queries, "list_conversations", fake_list)
    await queries.list_conversations_page(
        object(), casa_id=1, limit=50, cursor_ts=base, cursor_id=42
    )
    assert seen["cursor_ts"] == base
    assert seen["cursor_id"] == 42
