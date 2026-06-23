"""Pure tests for the F3 webhook location extractor (defensive multi-shape parse).

WAHA does not publish a canonical incoming-location example and the field path
varies by engine/version, so the webhook tries several known shapes. These tests
pin each supported shape, the range/finite validation, and the "not a location"
None path — all pure (no DB / network), mirroring the unit style of the repo.
"""
from __future__ import annotations

import pytest

from app.routes.webhooks import _coerce_coord, _extract_location


# ── _coerce_coord (validation primitive) ─────────────────────────────
def test_coerce_valid_pair():
    assert _coerce_coord(39.47, -0.37) == (39.47, -0.37)


def test_coerce_stringy_numbers():
    assert _coerce_coord("39.47", "-0.37") == (39.47, -0.37)


@pytest.mark.parametrize(
    "lat,lng",
    [
        (91.0, 0.0),       # lat out of range
        (-91.0, 0.0),
        (0.0, 181.0),      # lng out of range
        (0.0, -181.0),
        (float("nan"), 0.0),
        (float("inf"), 0.0),
        ("x", 0.0),        # non-numeric
        (None, 0.0),
    ],
)
def test_coerce_rejects_invalid(lat, lng):
    assert _coerce_coord(lat, lng) is None


# ── _extract_location (multi-shape, first non-null wins) ──────────────
def test_extract_waha_normalized_top_level():
    data = {"type": "location", "location": {"latitude": 39.47, "longitude": -0.37}}
    assert _extract_location(data, {}) == (39.47, -0.37)


def test_extract_baileys_raw_proto_location_message():
    _d = {"message": {"locationMessage": {"degreesLatitude": 40.42, "degreesLongitude": -3.70}}}
    assert _extract_location({}, _d) == (40.42, -3.70)


def test_extract_noweb_alt_nesting():
    _d = {"location": {"degreesLatitude": 38.91, "degreesLongitude": 1.43}}
    assert _extract_location({}, _d) == (38.91, 1.43)


def test_extract_flat_fallback_on_payload():
    data = {"lat": 36.51, "lng": -4.88}
    assert _extract_location(data, {}) == (36.51, -4.88)


def test_extract_flat_fallback_on_data():
    _d = {"lat": 36.51, "lng": -4.88}
    assert _extract_location({}, _d) == (36.51, -4.88)


def test_extract_priority_normalized_beats_raw():
    """When both the normalized object and the raw proto are present, the
    normalized top-level location wins (priority order)."""
    data = {"location": {"latitude": 1.0, "longitude": 2.0}}
    _d = {"message": {"locationMessage": {"degreesLatitude": 9.0, "degreesLongitude": 9.0}}}
    assert _extract_location(data, _d) == (1.0, 2.0)


def test_extract_none_for_plain_text_message():
    data = {"type": "chat", "body": "hola", "hasMedia": False}
    assert _extract_location(data, {}) is None


def test_extract_none_for_location_with_garbage_coords():
    """A location-shaped payload with out-of-range coords yields None (rejected)."""
    data = {"type": "location", "location": {"latitude": 999.0, "longitude": 0.0}}
    assert _extract_location(data, {}) is None
