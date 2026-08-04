"""Pure unit tests for the F3 outcall price calculator (app.agent.outcall).

The arithmetic is the load-bearing part of F3 (CLAUDE.md: "LLMs are bad at
arithmetic" — the price MUST be computed in Python), so these tests pin down the
formula precisely: Haversine distance, the road factor, round-trip doubling,
day-vs-night per-km selection, the x1.20 taxi buffer, the min-fare floor, and the
ceil-to-10 rounding. No DB / LLM / network — all functions are pure.
"""
from __future__ import annotations

import math
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

from app.agent import outcall
from app.agent.outcall import (
    ROAD_FACTOR,
    TAXI_TARIFFS,
    estimate_outcall,
    haversine_km,
    is_night,
)

_MADRID = ZoneInfo("Europe/Madrid")

# Reference city-centre coordinates (WGS-84).
_VLC = (39.4699, -0.3763)   # Valencia
_MAD = (40.4168, -3.7038)   # Madrid


# ── haversine_km ─────────────────────────────────────────────────────
def test_haversine_known_city_pair_within_tolerance():
    """Valencia → Madrid great-circle is ~302 km (known reference ~300 km)."""
    km = haversine_km(*_VLC, *_MAD)
    assert km == pytest.approx(302.6, abs=2.0)


def test_haversine_identical_points_is_zero():
    assert haversine_km(*_VLC, *_VLC) == pytest.approx(0.0, abs=1e-9)


def test_haversine_is_symmetric():
    assert haversine_km(*_VLC, *_MAD) == pytest.approx(haversine_km(*_MAD, *_VLC))


# ── outcall_base_from_rates (synced web rate → base price) ────────────
def test_outcall_base_parsed_from_web_rate():
    """'Hotel/outcall' → 'desde 150€' yields 150.0 (VLC real shape)."""
    rates = {"items": [
        {"label_en": "1 hour", "price": "100€"},
        {"label_en": "Hotel/outcall", "price": "desde 150€"},
    ]}
    assert outcall.outcall_base_from_rates(rates) == 150.0


def test_outcall_base_none_when_price_non_numeric():
    """'A hotel/domicilio' → 'consultar/ask' has no number → None (defer)."""
    rates = {"items": [{"label_es": "A hotel/domicilio", "price": "consultar/ask"}]}
    assert outcall.outcall_base_from_rates(rates) is None


def test_outcall_base_none_when_no_outcall_item():
    """No outcall-labelled item (Marbella shape) → None → defer."""
    rates = {"items": [
        {"label_en": "1 hour", "price": "240€"},
        {"label_en": "Yacht / private event", "price": "consultar/ask"},
    ]}
    assert outcall.outcall_base_from_rates(rates) is None


def test_outcall_base_parses_plain_amount():
    """A numeric outcall price ('200€') parses to 200.0."""
    rates = {"items": [{"label_es": "A hotel/domicilio", "price": "200€"}]}
    assert outcall.outcall_base_from_rates(rates) == 200.0


def test_outcall_base_handles_missing_or_malformed_rates():
    assert outcall.outcall_base_from_rates(None) is None
    assert outcall.outcall_base_from_rates({}) is None
    assert outcall.outcall_base_from_rates({"items": "nope"}) is None
    assert outcall.outcall_base_from_rates({"items": [None, 5, "x"]}) is None


def test_haversine_one_degree_latitude_is_about_111km():
    """One degree of latitude ≈ 111 km anywhere — a clean sanity anchor."""
    assert haversine_km(0.0, 0.0, 1.0, 0.0) == pytest.approx(111.2, abs=1.0)


# ── is_night ─────────────────────────────────────────────────────────
@pytest.mark.parametrize(
    "hour,city,expected",
    [
        (13, "Valencia", False),   # mid-afternoon → day
        (23, "Valencia", True),    # 23:00 inside 21:00-07:00 → night
        (3, "Valencia", True),     # 03:00 (wrapped past midnight) → night
        (8, "Valencia", False),    # 08:00 after 07:00 end → day
        (22, "Madrid", True),      # Madrid night band 21:00-07:00
        (20, "Madrid", False),     # 20:00 just before band → day
        (22, "Malaga", True),      # Marbella band starts 22:00
        (21, "Malaga", False),     # 21:00 before Marbella band → day
        (5, "Malaga", True),       # 05:00 before 06:00 end → night
        (6, "Malaga", False),      # 06:00 == end (exclusive) → day
    ],
)
def test_is_night_windows_per_city(hour, city, expected):
    now = datetime(2026, 6, 17, hour, 0, tzinfo=_MADRID)
    assert is_night(now, city) is expected


def test_is_night_unknown_city_is_false():
    # Defensive: never up-charge to the night tariff for an unmodelled city.
    assert is_night(datetime(2026, 6, 17, 23, 0, tzinfo=_MADRID), "Nope") is False


# ── estimate_outcall — None guards ───────────────────────────────────
_DAY = datetime(2026, 6, 17, 13, 0, tzinfo=_MADRID)
_NIGHT = datetime(2026, 6, 17, 23, 0, tzinfo=_MADRID)


def test_estimate_none_without_casa_coords():
    assert estimate_outcall(None, _VLC, "Valencia", 150.0, _DAY) is None


def test_estimate_none_without_client_coords():
    assert estimate_outcall(_VLC, None, "Valencia", 150.0, _DAY) is None


def test_estimate_none_for_unknown_city():
    assert estimate_outcall(_VLC, _MAD, "Atlantis", 150.0, _DAY) is None


@pytest.mark.parametrize("base", [None, 0, -50])
def test_estimate_none_for_missing_or_nonpositive_base(base):
    assert estimate_outcall(_VLC, _MAD, "Valencia", base, _DAY) is None


# ── estimate_outcall — formula ───────────────────────────────────────
def test_estimate_applies_road_factor_and_roundtrip():
    """one-way = haversine * ROAD_FACTOR; round-trip = one-way * 2."""
    client = (39.4699, -0.4763)  # ~8.6 km west of the casa
    est = estimate_outcall(_VLC, client, "Valencia", 150.0, _DAY)
    assert est is not None
    raw_km = haversine_km(*_VLC, *client)
    assert est.distance_oneway_km == pytest.approx(raw_km * ROAD_FACTOR, abs=0.01)
    assert est.distance_roundtrip_km == pytest.approx(est.distance_oneway_km * 2, abs=0.01)


def test_estimate_night_costs_more_than_day():
    """Night per-km yields a higher taxi than day at the same distance; both totals
    stay ceil'd to a multiple of 10."""
    client = (39.4699, -0.4763)
    day = estimate_outcall(_VLC, client, "Valencia", 150.0, _DAY)
    night = estimate_outcall(_VLC, client, "Valencia", 150.0, _NIGHT)
    assert day is not None and night is not None
    assert night.taxi_cost_eur > day.taxi_cost_eur
    assert night.total_eur >= day.total_eur
    assert day.total_eur % 10 == 0 and night.total_eur % 10 == 0


def test_estimate_taxi_is_two_one_way_fares():
    """Round-trip taxi = 2 × one-way fare — each leg its own flagfall + min fare
    (ida + vuelta), not a single fare over the round-trip distance."""
    client = (39.4699, -0.4763)
    est = estimate_outcall(_VLC, client, "Valencia", 150.0, _DAY)
    assert est is not None
    t = TAXI_TARIFFS["Valencia"]
    oneway_km = haversine_km(*_VLC, *client) * ROAD_FACTOR
    leg = max(t.flagfall_eur + t.per_km_day_eur * oneway_km, t.min_fare_eur)
    assert est.taxi_cost_eur == pytest.approx(leg * 2, abs=0.02)


def test_estimate_total_is_base_plus_buffered_taxi_ceiled_to_10():
    """total == ceil_to_10(base + taxi_cost * buffer), recomputed independently."""
    client = (39.4699, -0.4763)
    base = 150.0
    est = estimate_outcall(_VLC, client, "Valencia", base, _DAY, taxi_buffer=1.20)
    assert est is not None
    expected = int(math.ceil((base + est.taxi_cost_eur * 1.20) / 10) * 10)
    assert est.total_eur == expected
    assert est.total_eur % 10 == 0


def test_estimate_breakdown_base_plus_taxi_equals_total():
    """The client-facing breakdown adds up: base_eur + taxi_eur == total_eur, and
    base_eur is the (rounded) domicilio base."""
    client = (39.4699, -0.4763)
    est = estimate_outcall(_VLC, client, "Valencia", 150.0, _DAY)
    assert est is not None
    assert est.base_eur == 150
    assert est.taxi_eur > 0
    assert est.base_eur + est.taxi_eur == est.total_eur


def test_estimate_taxi_buffer_override_changes_total():
    """A higher per-casa buffer (e.g. 50% → 1.50) yields a >= total vs the default."""
    client = (39.4699, -0.4763)
    low = estimate_outcall(_VLC, client, "Valencia", 150.0, _DAY, taxi_buffer=1.20)
    high = estimate_outcall(_VLC, client, "Valencia", 150.0, _DAY, taxi_buffer=1.50)
    assert low is not None and high is not None
    assert high.total_eur >= low.total_eur
    assert high.total_eur > low.total_eur  # 1.50 buffer clearly raises it


def test_estimate_min_fare_floor_applies_for_tiny_distance():
    """A near-zero distance falls back to TWO city min-fares (ida + vuelta = 2 legs
    each floored at the min fare)."""
    client = (39.46995, -0.37635)  # ~5 m away
    est = estimate_outcall(_VLC, client, "Valencia", 150.0, _DAY)
    assert est is not None
    assert est.taxi_cost_eur == pytest.approx(2 * TAXI_TARIFFS["Valencia"].min_fare_eur, abs=0.5)


# ── taxi RANGE (horquilla) — the client-facing figure Sara actually quotes ──
def test_estimate_produces_lean_expensive_taxi_range():
    """Sara quotes a RANGE, not the exact figure: low < high, both multiples of 10,
    low never below the floor, and the high end sits ABOVE the bare metered cost."""
    client = (39.4699, -0.4763)  # ~8.6 km west of the casa
    est = estimate_outcall(_VLC, client, "Valencia", 150.0, _DAY)
    assert est is not None
    assert est.taxi_low_eur % 10 == 0 and est.taxi_high_eur % 10 == 0
    assert est.taxi_low_eur < est.taxi_high_eur
    assert est.taxi_low_eur >= outcall.TAXI_RANGE_MIN_LOW_EUR
    assert est.taxi_high_eur > est.taxi_cost_eur  # leans expensive vs the raw meter


def test_estimate_tiny_distance_floors_the_range_low():
    """A near-zero distance still yields a realistic minimum low end (the floor),
    with a high end strictly above it."""
    client = (39.46995, -0.37635)  # ~5 m away
    est = estimate_outcall(_VLC, client, "Valencia", 150.0, _DAY)
    assert est is not None
    assert est.taxi_low_eur == outcall.TAXI_RANGE_MIN_LOW_EUR
    assert est.taxi_high_eur > est.taxi_low_eur


def test_estimate_farther_client_gets_a_pricier_range():
    """The range scales with distance: a farther client gets a higher low+high
    (addresses 'the taxi doesn't match the location')."""
    near = estimate_outcall(_VLC, (39.4699, -0.4763), "Valencia", 150.0, _DAY)
    far = estimate_outcall(_VLC, (39.4699, -0.7000), "Valencia", 150.0, _DAY)
    assert near is not None and far is not None
    assert far.taxi_low_eur > near.taxi_low_eur
    assert far.taxi_high_eur > near.taxi_high_eur


# ── city_for_casa_name ───────────────────────────────────────────────
@pytest.mark.parametrize(
    "name,expected",
    [
        ("Maxxage Valencia", "Valencia"),
        ("maxxage vlc", "Valencia"),
        ("Maxxage Madrid", "Madrid"),
        ("Mansion Babylon Marbella", "Malaga"),  # Marbella → Malaga tariff
        ("Ibiza Nights", "Ibiza"),
        ("Eivissa Club", "Ibiza"),
        ("Unknown Place", None),
        (None, None),
    ],
)
def test_city_for_casa_name(name, expected):
    assert outcall.city_for_casa_name(name) == expected
