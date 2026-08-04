"""Shared "this WhatsApp line is being actively paired right now" signal.

The health-check worker STOPS un-authed sessions to halt WhatsApp registration
churn (the cause of the daily de-linking). This flag tells it to leave a session
alone while a human is actively pairing it — either the admin in the Conectar
modal, or a casa manager scanning a shared QR link on her own phone. Set and
refreshed by the Conectar routes and the public QR page; short TTL so it clears
soon after the pairing UI is closed and the worker can stop an abandoned scan.

The worker reads the same key (kept in sync with `pairing_key`).
"""
from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

PAIRING_FLAG_TTL = 180  # seconds a line stays "being paired" after the last refresh


def pairing_key(name: str) -> str:
    return f"wa:pairing:{name}"


async def mark_pairing(redis, name: str) -> None:
    """Signal the health-check that session `name` is being actively paired.

    Fire-and-forget: a Redis hiccup must never break the pairing request itself.
    """
    try:
        await redis.set(pairing_key(name), "1", ex=PAIRING_FLAG_TTL)
    except Exception:  # noqa: BLE001 — best effort; the worst case is a stopped scan
        logger.warning("could not set pairing flag for %s", name, exc_info=True)
