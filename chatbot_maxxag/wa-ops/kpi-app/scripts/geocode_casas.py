#!/usr/bin/env python3
"""One-off geocoder for casa addresses → casa_profile.address_lat/address_lng.

F3 OUTCALL CALCULATOR needs each casa's coordinates to compute the Haversine
distance to the client's location PIN. The casa `address` (text) is synced from
the website feed, but `address_lat`/`address_lng` start NULL and nothing writes
them — this script fills them once.

Strategy (cheapest first, zero new infra, no API key):
  1. Parse coordinates straight out of `maps_url` when it already embeds them
     (Google Maps `@lat,lng` or `?q=lat,lng` / `query=lat,lng`). FREE, instant.
  2. Otherwise geocode `address` via Nominatim/OpenStreetMap. No API key; we honor
     the usage policy: a real descriptive User-Agent and <= 1 request/second.

Only casas whose coords are still NULL are processed (idempotent). Manual
overrides are allowed — once a casa has coords, this script leaves it alone.

Usage (run from kpi-app/):
    python -m scripts.geocode_casas            # DRY RUN — prints what it would do
    python -m scripts.geocode_casas --apply    # actually persist coordinates
    python -m scripts.geocode_casas --apply --casa-id 3   # restrict to one casa

DATABASE_URL is read from the environment (same DSN the app uses). Any
SQLAlchemy driver suffix (e.g. +asyncpg) is stripped for the raw asyncpg connect.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import re
import sys
import urllib.parse
import urllib.request

import asyncpg

logger = logging.getLogger("geocode_casas")

# Nominatim usage policy: descriptive UA + max 1 req/s. See
# https://operations.osmfoundation.org/policies/nominatim/
_NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
_USER_AGENT = "wa-ops-geocoder/1.0 (admin@masajesmaxx.com)"
_REQUEST_GAP_S = 1.1  # > 1s to stay polite
_HTTP_TIMEOUT_S = 15.0

# Coordinate patterns inside a Google Maps URL.
_MAPS_AT_RE = re.compile(r"@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)")
_MAPS_Q_RE = re.compile(r"[?&](?:q|query|ll)=(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)")

_LAT_MIN, _LAT_MAX = -90.0, 90.0
_LNG_MIN, _LNG_MAX = -180.0, 180.0


def _dsn_from_env() -> str:
    """Read DATABASE_URL and strip any SQLAlchemy '+driver' suffix for asyncpg."""
    raw = os.environ.get("DATABASE_URL")
    if not raw:
        sys.exit("DATABASE_URL not set in the environment")
    # postgresql+asyncpg://... / postgresql+psycopg://... → postgresql://...
    return re.sub(r"^postgresql\+\w+://", "postgresql://", raw)


def _valid(lat: float, lng: float) -> bool:
    return _LAT_MIN <= lat <= _LAT_MAX and _LNG_MIN <= lng <= _LNG_MAX


def coords_from_maps_url(maps_url: str | None) -> tuple[float, float] | None:
    """Extract (lat, lng) embedded in a Google Maps URL, or None. Pure."""
    if not maps_url:
        return None
    for pattern in (_MAPS_AT_RE, _MAPS_Q_RE):
        m = pattern.search(maps_url)
        if m:
            lat, lng = float(m.group(1)), float(m.group(2))
            if _valid(lat, lng):
                return (lat, lng)
    return None


def geocode_nominatim(address: str) -> tuple[float, float] | None:
    """Geocode a free-text address via Nominatim. Returns (lat, lng) or None.

    Blocking urllib call (this is a one-off script, not the live path). Sends the
    required descriptive User-Agent. The caller paces requests to <= 1/s. Country
    is biased to Spain (es) since all casas are in Spain. Never raises — logs and
    returns None on any error.
    """
    if not address or not address.strip():
        return None
    params = urllib.parse.urlencode(
        {"q": address, "format": "json", "limit": "1", "countrycodes": "es"}
    )
    req = urllib.request.Request(
        f"{_NOMINATIM_URL}?{params}", headers={"User-Agent": _USER_AGENT}
    )
    try:
        with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT_S) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as exc:  # one-off script: log and skip on any error
        logger.warning("nominatim failed for %r: %s", address, exc)
        return None
    if not data:
        return None
    try:
        lat, lng = float(data[0]["lat"]), float(data[0]["lon"])
    except (KeyError, IndexError, TypeError, ValueError):
        return None
    return (lat, lng) if _valid(lat, lng) else None


async def _load_targets(conn, casa_id: int | None) -> list[asyncpg.Record]:
    """Fetch casa_profile rows still missing coords (optionally one casa_id)."""
    if casa_id is not None:
        return await conn.fetch(
            """
            SELECT cp.casa_id, c.name, cp.address, cp.maps_url
            FROM casa_profile cp JOIN casa c ON c.id = cp.casa_id
            WHERE cp.casa_id = $1
              AND (cp.address_lat IS NULL OR cp.address_lng IS NULL)
            """,
            casa_id,
        )
    return await conn.fetch(
        """
        SELECT cp.casa_id, c.name, cp.address, cp.maps_url
        FROM casa_profile cp JOIN casa c ON c.id = cp.casa_id
        WHERE cp.address_lat IS NULL OR cp.address_lng IS NULL
        ORDER BY cp.casa_id
        """
    )


async def run(apply: bool, casa_id: int | None) -> int:
    """Geocode all (or one) un-geocoded casa. Returns the count persisted."""
    conn = await asyncpg.connect(_dsn_from_env())
    persisted = 0
    try:
        targets = await _load_targets(conn, casa_id)
        if not targets:
            logger.info("no casas need geocoding (all have coords)")
            return 0
        for i, row in enumerate(targets):
            cid, name = row["casa_id"], row["name"]
            coords = coords_from_maps_url(row["maps_url"])
            source = "maps_url"
            if coords is None:
                if i > 0:
                    await asyncio.sleep(_REQUEST_GAP_S)  # pace Nominatim
                coords = geocode_nominatim(row["address"] or "")
                source = "nominatim"
            if coords is None:
                logger.warning("casa %s (%s): could not geocode — skip", cid, name)
                continue
            lat, lng = coords
            logger.info(
                "casa %s (%s): %.6f,%.6f via %s%s",
                cid, name, lat, lng, source, "" if apply else " [DRY RUN]",
            )
            if apply:
                # Conditional write: only fill while still NULL (respect manual
                # overrides made between load and write).
                done = await conn.fetchval(
                    """
                    UPDATE casa_profile
                    SET address_lat = $2, address_lng = $3, updated_at = now()
                    WHERE casa_id = $1
                      AND (address_lat IS NULL OR address_lng IS NULL)
                    RETURNING casa_id
                    """,
                    cid, lat, lng,
                )
                if done is not None:
                    persisted += 1
    finally:
        await conn.close()
    return persisted


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    parser = argparse.ArgumentParser(description="Geocode casa addresses (one-off).")
    parser.add_argument("--apply", action="store_true", help="persist (default: dry run)")
    parser.add_argument("--casa-id", type=int, default=None, help="restrict to one casa")
    args = parser.parse_args()
    persisted = asyncio.run(run(apply=args.apply, casa_id=args.casa_id))
    if args.apply:
        logger.info("persisted coordinates for %s casa(s)", persisted)
    else:
        logger.info("dry run complete — re-run with --apply to persist")


if __name__ == "__main__":
    main()
