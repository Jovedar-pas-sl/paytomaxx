"""F3 OUTCALL price calculator — PURE, fully unit-testable, zero new infra.

When a client wants an OUTCALL (the girl travels to them), Sara quotes a price
ONLY AFTER receiving the client's WhatsApp location PIN. The price is computed
DETERMINISTICALLY here in Python (CLAUDE.md rule: LLMs are bad at arithmetic, so
the model only PHRASES the precomputed number, it never recomputes it).

FORMULA (decided):
    distance_oneway_km   = haversine(casa_coords, client_coords) * ROAD_FACTOR
    distance_roundtrip_km = distance_oneway_km * 2
    taxi_cost_eur        = city tariff applied to the ROUND-TRIP distance
                           (flagfall + per_km, using the NIGHT per_km when the
                            local time is inside the city night window, floored
                            at the city min_fare)
    total_eur            = ceil_to_10(casa_outcall_base + taxi_cost * TAXI_BUFFER)

NO routing engine / NO Valhalla — the VPS is tiny (1 vCPU, 3.8GB RAM). Haversine
great-circle distance with a flat road factor is the whole geometry model.

estimate_outcall returns None whenever an input is missing (no casa coords / no
client coords / unknown city / no outcall base) so the caller (auto_reply) falls
back gracefully and Sara defers instead of inventing a price.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass
from datetime import datetime, time

# NOTE on timezone: `now_local` is expected to be an Europe/Madrid-localized
# datetime (the caller builds it from rate_limit._MADRID — all four cities are in
# peninsular/Balearic Spain on that wall clock). This module only reads the hour,
# so it stays tz-agnostic and pure.

# ── Named formula constants ──────────────────────────────────────────
# Great-circle → road distance inflation. A straight Haversine line under-counts
# real driving distance; 1.3 is the conventional urban detour factor.
ROAD_FACTOR: float = 1.3
# Buffer applied to the metered taxi cost before adding the casa base (covers
# tip / waiting / our margin). The casa `outcall` JSONB may override this per
# casa (taxi_surcharge_pct); this is the default when absent.
TAXI_BUFFER: float = 1.20
# Final price is always rounded UP to the nearest multiple of this (euros).
ROUND_TO_EUR: int = 10

# Earth mean radius (km) for the Haversine formula.
_EARTH_RADIUS_KM: float = 6371.0088


# ── Per-city taxi tariff tables ──────────────────────────────────────
# VALIDATE BEFORE ACTIVATION. These are the researched 2025/2026 official
# tariffs (see sources in the F3 briefing). Each field:
#   flagfall_eur   — "bajada de bandera" (day tariff / Tarifa 1)
#   per_km_day_eur — Tarifa 1 €/km
#   per_km_night_eur — night/holiday tariff (Tarifa 2) €/km
#   min_fare_eur   — minimum urban fare floor (day); 0 when the city publishes
#                    no general urban minimum (Madrid, Ibiza)
#   night_start/night_end — night window in LOCAL (Europe/Madrid) wall-clock
#                    hours; wraps past midnight when start > end. These encode
#                    the EVERYDAY night band; weekend/holiday all-day Tarifa 2 is
#                    intentionally NOT modelled here (kept simple — a quote made
#                    on a Saturday afternoon uses the day tariff). VALIDATE.
@dataclass(frozen=True)
class TaxiTariff:
    flagfall_eur: float
    per_km_day_eur: float
    per_km_night_eur: float
    min_fare_eur: float
    night_start_hour: int  # local hour the night band begins (inclusive)
    night_end_hour: int    # local hour the night band ends (exclusive)


# Keyed by CITY name (see CASA_CITY for the casa→city mapping). VALIDATE values
# against the official municipal/island resolutions before turning F3 live.
TAXI_TARIFFS: dict[str, TaxiTariff] = {
    # Valencia APC (ciudad). Tarifa 1 fields; per_km_night = Tarifa 2 €/km.
    # Night band 21:00-07:00 every day. min_fare reflects Tarifa 1 (4.95€).
    # Source: todotaxi.org / taxival.org / free-now — DOGV res. 30-dic-2025 (~9% up).
    "Valencia": TaxiTariff(
        flagfall_eur=2.00,
        per_km_day_eur=1.36,
        per_km_night_eur=1.48,
        min_fare_eur=4.95,
        night_start_hour=21,
        night_end_hour=7,
    ),
    # Madrid capital. Night band 21:00-07:00 every day. No general urban minimum
    # (fixed airport/station tariffs are out of scope) → min_fare = 0.
    # Source: taxmad.es + Ayto. de Madrid (vigente 1-ene-2026, +2.36%).
    "Madrid": TaxiTariff(
        flagfall_eur=2.55,
        per_km_day_eur=1.40,
        per_km_night_eur=1.60,
        min_fare_eur=0.0,
        night_start_hour=21,
        night_end_hour=7,
    ),
    # Marbella (municipio propio, NOT Málaga capital). Night band 22:00-06:00.
    # min_fare = Tarifa 1 minimum (5.19€). Source: Ayto. de Marbella (aprob.
    # 25-abr-2024). Confidence MEDIUM — last published municipal revision is 2024.
    "Malaga": TaxiTariff(
        flagfall_eur=3.61,
        per_km_day_eur=1.07,
        per_km_night_eur=1.34,
        min_fare_eur=5.19,
        night_start_hour=22,
        night_end_hour=6,
    ),
    # Ibiza / Eivissa (ciudad, Consell Insular). Night band 21:00-07:00. No
    # published general urban minimum → min_fare = 0. per_km_night = 1.47€/km
    # (some secondary sources cite 1.33 — VERIFY in the BOIB). Source:
    # todotaxi.org / turismoibiza — 2025 figures. Confidence MEDIUM.
    "Ibiza": TaxiTariff(
        flagfall_eur=4.00,
        per_km_day_eur=1.21,
        per_km_night_eur=1.47,
        min_fare_eur=0.0,
        night_start_hour=21,
        night_end_hour=7,
    ),
}

# Casa keyword → tariff city. The casa keyword is the short code embedded in the
# casa name (vlc/madrid/marbella/ibiza); the value is the TAXI_TARIFFS key. The
# keywords mirror website_sync.CASA_SITES so the casa→city mapping stays aligned
# with the existing sync routing. Extra aliases (e.g. "valencia") are included so
# a casa named in full still resolves.
CASA_CITY: dict[str, str] = {
    "vlc": "Valencia",
    "valencia": "Valencia",
    "madrid": "Madrid",
    "marbella": "Malaga",   # Marbella's own urban tariff lives under "Malaga"
    "ibiza": "Ibiza",
    "eivissa": "Ibiza",
}


def city_for_casa_name(casa_name: str | None) -> str | None:
    """Resolve a casa display name to a TAXI_TARIFFS city key, or None.

    Scans the lowercased casa name for any CASA_CITY keyword (e.g. a casa named
    "Maxxage Valencia" → "Valencia", "Mansion Babylon Marbella" → "Malaga").
    Pure; returns None when no keyword matches so the caller defers the quote.
    """
    if not casa_name:
        return None
    lowered = casa_name.lower()
    for keyword, city in CASA_CITY.items():
        if keyword in lowered:
            return city
    return None


@dataclass(frozen=True)
class OutcallEstimate:
    """Deterministic price breakdown for one outcall quote.

    Sara quotes the BREAKDOWN to the client: `base_eur` (the domicilio service
    price) + `taxi_eur` (the round-trip taxi). They always satisfy
    `base_eur + taxi_eur == total_eur` (taxi absorbs the ceil-to-10 rounding), so
    the two shown numbers add up. `taxi_cost_eur`/distances are for logging."""

    distance_oneway_km: float
    distance_roundtrip_km: float
    taxi_cost_eur: float
    base_eur: int
    taxi_eur: int
    total_eur: int


def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance in km between two WGS-84 points (Haversine).

    Pure. Symmetric, returns 0.0 for identical points. No routing — this is the
    straight-line distance; callers apply ROAD_FACTOR for a driving estimate.
    """
    rlat1, rlat2 = math.radians(lat1), math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(rlat1) * math.cos(rlat2) * math.sin(dlng / 2) ** 2
    )
    c = 2 * math.asin(min(1.0, math.sqrt(a)))
    return _EARTH_RADIUS_KM * c


def is_night(now_local: datetime, city: str) -> bool:
    """True when `now_local` falls inside `city`'s night taxi-tariff window.

    `now_local` is interpreted in its own wall-clock time (it is expected to be a
    Europe/Madrid-localized datetime, but only the hour is read). Unknown city →
    False (defensive: never up-charge to the night tariff for a city we don't
    model). The window wraps past midnight when night_start > night_end.
    """
    tariff = TAXI_TARIFFS.get(city)
    if tariff is None:
        return False
    start = time(hour=tariff.night_start_hour)
    end = time(hour=tariff.night_end_hour)
    current = time(hour=now_local.hour, minute=now_local.minute)
    if start < end:
        # Same-day band (would be unusual for a night window, kept for safety).
        return start <= current < end
    # Wrap past midnight, e.g. 21:00 → next-day 07:00.
    return current >= start or current < end


def _ceil_to_10(value: float) -> int:
    """Round a euro amount UP to the next multiple of ROUND_TO_EUR."""
    return int(math.ceil(value / ROUND_TO_EUR) * ROUND_TO_EUR)


# Rate-item labels (lowercased) that denote the OUTCALL service ("a hotel /
# domicilio / salida / desplazamiento"), so the synced web rate can seed the
# outcall base price without manual entry.
_OUTCALL_LABEL_KEYWORDS: tuple[str, ...] = (
    "hotel", "domicilio", "outcall", "salida", "desplazamiento", "fuera",
)
# First 2-4 digit number in a price string ("desde 150€" -> 150, "150€" -> 150).
_PRICE_NUM_RE = re.compile(r"\d{2,4}")


def outcall_base_from_rates(rates: dict | None) -> float | None:
    """Parse the outcall base price (euros) from the casa's synced rates JSONB.

    Scans rates["items"] for an item whose label (any `label`/`label_*` field)
    names the outcall service, then extracts the first euro amount from its price
    string ("desde 150€" -> 150.0). Returns None when there is no outcall item or
    its price is non-numeric ("consultar/ask") — the caller then defers. Pure +
    defensive (never raises). A manual casa_profile.outcall.base_price_eur
    overrides this upstream.
    """
    if not isinstance(rates, dict):
        return None
    items = rates.get("items")
    if not isinstance(items, list):
        return None
    for item in items:
        if not isinstance(item, dict):
            continue
        labels = " ".join(
            str(v) for k, v in item.items() if k == "label" or k.startswith("label_")
        ).lower()
        if not any(kw in labels for kw in _OUTCALL_LABEL_KEYWORDS):
            continue
        # Outcall item found — parse its price; non-numeric ("consultar") → defer.
        match = _PRICE_NUM_RE.search(str(item.get("price") or ""))
        return float(match.group()) if match else None
    return None


def estimate_outcall(
    casa_coords: tuple[float, float] | None,
    client_coords: tuple[float, float] | None,
    city: str | None,
    outcall_base_eur: float | None,
    now_local: datetime,
    *,
    taxi_buffer: float = TAXI_BUFFER,
) -> OutcallEstimate | None:
    """Compute the deterministic outcall price, or None when inputs are missing.

    Returns None (caller defers, Sara never invents a price) when:
      * casa_coords is None (the casa has no geocoded address),
      * client_coords is None (no location PIN received yet),
      * city is unknown / has no tariff table,
      * outcall_base_eur is missing or non-positive.

    `taxi_buffer` lets the per-casa `outcall.taxi_surcharge_pct` override the
    default 1.20; the caller converts the stored percent (e.g. 20) to a factor.
    """
    if casa_coords is None or client_coords is None:
        return None
    if not city:
        return None
    tariff = TAXI_TARIFFS.get(city)
    if tariff is None:
        return None
    if outcall_base_eur is None or outcall_base_eur <= 0:
        return None

    oneway = haversine_km(
        casa_coords[0], casa_coords[1], client_coords[0], client_coords[1]
    ) * ROAD_FACTOR
    roundtrip = oneway * 2

    per_km = (
        tariff.per_km_night_eur if is_night(now_local, city) else tariff.per_km_day_eur
    )
    metered = tariff.flagfall_eur + per_km * roundtrip
    taxi_cost = max(metered, tariff.min_fare_eur)

    total = _ceil_to_10(outcall_base_eur + taxi_cost * taxi_buffer)
    # Breakdown the client is told: base (domicilio) + taxi. taxi_eur is the
    # remainder so base+taxi == total exactly (taxi absorbs the ceil-to-10).
    base_int = int(round(outcall_base_eur))
    return OutcallEstimate(
        distance_oneway_km=round(oneway, 2),
        distance_roundtrip_km=round(roundtrip, 2),
        taxi_cost_eur=round(taxi_cost, 2),
        base_eur=base_int,
        taxi_eur=total - base_int,
        total_eur=total,
    )
