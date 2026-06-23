"""website_sync — mirror each casa's LIVE website JSON into the KPI DB.

Every casa's public website exposes the same JSON the WhatsApp chatbot already
consumes (girls + config). There are TWO verified-live API flavors:

  FLAVOR "chatbot" (custom platform, e.g. VLC):
    GET {base}/chatbot/api/config        → site / rates / schedule / faqs
    GET {base}/chatbot/api/girls         → JSON ARRAY of the listed girls
    (no available_today / outcall / languages fields; photo is RELATIVE)

  FLAVOR "wpjson" (WordPress plugin, e.g. Madrid, Marbella):
    GET {base}/wp-json/maxxag/v1/config  → same config shape
    GET {base}/wp-json/maxxag/v1/girls   → OBJECT { "girls": [ ... ] }
    (has available_today / outcall / languages bools/lists; photo_url ABSOLUTE)

The config payload shape is identical across both flavors. Some sites omit
whatsapp_recepcion / telegram_recepcion / faqs — missing keys are handled
gracefully.

This module pulls both endpoints and mirrors them into `casa_profile` and
`girl`, so the reply agent always sees the CURRENT girls + rates without anyone
hand-editing the DB. It runs on a periodic arq cron (every ~20 min) and can also
be enqueued on demand for an immediate first sync.

Design notes:
  * Fault-tolerant per casa: a single bad website (down, 500, malformed JSON)
    logs a warning and is skipped — it must NEVER break the sync of the others.
  * Bounded HTTP only (httpx, 10s timeout, raise_for_status). No long
    asyncio.sleep — this honors CLAUDE.md rule 6 / "No hacer" (long sleeps
    block the worker event loop).
  * All SQL lives in app/queries.py (project rule "todo el SQL en queries.py").
    The casa_profile `outcall` pricing JSONB is curated by hand and is preserved
    by the upsert helper (never overwritten from the website feed).
  * Deactivation guard: a casa's girls absent from the freshly fetched id set are
    soft-deleted ONLY when the girls list parsed to a NON-EMPTY list. A
    failed/empty fetch deactivates nothing, so a transient website error can
    never wipe a casa's availability.
"""
from __future__ import annotations

import logging
from typing import Any
from urllib.parse import urlsplit

import asyncpg
import httpx

from app import queries

logger = logging.getLogger("agent.website_sync")

# ── HTTP ─────────────────────────────────────────────────────────────
_HTTP_TIMEOUT_S = 10.0

# Some casa sites sit behind a WAF / security plugin (Wordfence, Cloudflare…)
# that 403s the default httpx User-Agent ("python-httpx/…") as a bot. Send a
# realistic browser UA so the PUBLIC config/girls endpoints aren't blocked.
# Harmless for sites that don't filter (Madrid/VLC already work either way).
_SYNC_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
}

# Per-flavor (config_path, girls_path). The base URL comes from CASA_SITES.
PATHS: dict[str, tuple[str, str]] = {
    "chatbot": ("/chatbot/api/config", "/chatbot/api/girls"),
    "wpjson": ("/wp-json/maxxag/v1/config", "/wp-json/maxxag/v1/girls"),
}

# Plugin service label that flags couples-friendly girls (drives escort_pareja
# in the "chatbot" flavor, which has no explicit escort_pareja field).
_PAREJA_SERVICE = "Atención a parejas"

# ── Casa keyword → LIVE website {base, flavor} ───────────────────────
# Keyword is matched case-insensitively against casa.name (see sync_all).
CASA_SITES: dict[str, dict[str, str]] = {
    "vlc": {"base": "https://maxxagevlc.com", "flavor": "chatbot"},
    "madrid": {"base": "https://maxxagemadrid.com", "flavor": "wpjson"},
    "marbella": {
        "base": "https://mansionbabylonmarbella.com",
        "flavor": "wpjson",
    },
    "ibiza": {
        "base": "https://mansionbabylonibiza.com",
        "flavor": "wpjson",
    },
}


def _safe_int(value: Any) -> int | None:
    """Coerce a stringy/numeric `age` to int, guarding non-numeric → None.
    The "chatbot" flavor sends age as a string ("20"); "wpjson" sends an int."""
    if value is None:
        return None
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


def _as_bool(value: Any) -> bool:
    """Tolerant truthy parse. WordPress feeds often serialize booleans as strings
    ("0"/"1", "false"/"true") and Python's bool("0") is True — which would INVERT
    availability. Native bools pass through; strings/numbers map by value; missing
    → False."""
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    return str(value).strip().lower() in ("1", "true", "yes", "on")


def _safe_photo_url(base_url: str, photo: Any) -> str | None:
    """Absolutize + VALIDATE a girl photo URL from the (untrusted) website feed.

    Photos are rendered as <img src> in the dashboard, so a compromised/rogue
    feed could inject an off-site or non-https URL (stored-SSRF / mixed-content /
    cloud-metadata vector). Rules:
      * empty / non-str             → None
      * site-root-relative ("/...") → absolutized to the casa host (kept)
      * absolute, HTTPS, SAME host  → kept
      * anything else (cross-host, http://, file://, metadata) → None

    NOTE: a casa serving photos from a DIFFERENT host (e.g. a CDN/Jetpack domain)
    will have them dropped — verify photos still render after deploy; if a casa
    legitimately uses a CDN, allowlist that host here."""
    if not isinstance(photo, str) or not photo:
        return None
    base = base_url.rstrip("/")
    if photo.startswith("/"):
        return base + photo
    parts = urlsplit(photo)
    if parts.scheme != "https" or not parts.netloc:
        return None
    # Allow the same apex domain (incl. subdomains like a CDN); normalize a
    # leading www. on the site host so www.x.com and x.com are treated as one.
    apex = urlsplit(base).netloc
    if apex.startswith("www."):
        apex = apex[4:]
    host = parts.netloc
    if host == apex or host.endswith("." + apex):
        return photo
    return None


def _normalize_chatbot(base_url: str, g: dict) -> dict | None:
    """Map a raw "chatbot"-flavor girl dict to the girl-table fields.

    The "chatbot" feed has NO available_today / outcall / languages fields, so:
      * available_today / outcall default to TRUE (listed ⇒ assumed bookable),
      * languages defaults to [],
      * description comes from `tagline`,
      * escort_pareja is inferred from the services list.
    Returns None for rows without a usable `id` (can't key the upsert)."""
    ext_id = g.get("id")
    if not ext_id:
        return None
    services = list(g.get("services") or [])
    return {
        "ext_id": str(ext_id),
        "name": g.get("name") or str(ext_id),
        "age": _safe_int(g.get("age")),
        "nationality": g.get("nationality"),
        "description": g.get("tagline"),
        "photo_url": _safe_photo_url(base_url, g.get("photo")),
        "services": services,
        "languages": [],
        "whatsapp": None,
        "available_today": True,
        "outcall": True,
        "escort_pareja": _PAREJA_SERVICE in services,
        "active": True,
    }


def _normalize_wpjson(base_url: str, g: dict) -> dict | None:
    """Map a raw "wpjson"-flavor girl dict to the girl-table fields.

    The WordPress feed exposes explicit booleans/lists:
      * available_today / outcall come from the payload (coerced to bool),
      * languages come from the `languages` field,
      * description comes from `description`,
      * escort_pareja is the explicit `escort_pareja` flag OR inferred from a
        services entry mentioning "pareja".
    Returns None for rows without a usable `id`."""
    ext_id = g.get("id")
    if not ext_id:
        return None
    services = list(g.get("services") or [])
    pareja = bool(g.get("escort_pareja")) or (
        "pareja" in " ".join(str(s) for s in services).lower()
    )
    return {
        "ext_id": str(ext_id),
        "name": g.get("name") or str(ext_id),
        "age": _safe_int(g.get("age")),
        "nationality": g.get("nationality"),
        "description": g.get("description"),
        "photo_url": _safe_photo_url(base_url, g.get("photo_url")),
        "services": services,
        "languages": list(g.get("languages") or []),
        "whatsapp": None,
        "available_today": _as_bool(g.get("available_today")),
        "outcall": _as_bool(g.get("outcall")),
        "escort_pareja": pareja,
        "active": True,
    }


# Per-flavor girl normalizer.
_NORMALIZERS = {
    "chatbot": _normalize_chatbot,
    "wpjson": _normalize_wpjson,
}


def _girls_container(flavor: str, girls_payload: Any) -> list | None:
    """Extract the girls list from a flavor's raw payload. "chatbot" returns the
    array itself; "wpjson" wraps it in {"girls": [...]}. Returns None when the
    payload shape is unexpected (caller treats that as a failed fetch)."""
    if flavor == "chatbot":
        return girls_payload if isinstance(girls_payload, list) else None
    if flavor == "wpjson":
        if isinstance(girls_payload, dict):
            inner = girls_payload.get("girls")
            return inner if isinstance(inner, list) else None
        return None
    return None


async def sync_casa(
    pool: asyncpg.Pool,
    http: httpx.AsyncClient,
    casa_id: int,
    base: str,
    flavor: str,
) -> tuple[int, int]:
    """Fetch one casa's website config + girls and mirror them into the DB.

    Returns (girls_upserted, girls_deactivated). Fault-tolerant: any per-casa
    error (network, HTTP status, malformed JSON, DB) is logged as a warning and
    swallowed — the caller continues with the next casa. On failure returns
    (0, 0).

    Deactivation is performed ONLY when the girls payload parsed to a non-empty
    list, so a failed/empty fetch never wipes the casa's availability.
    """
    paths = PATHS.get(flavor)
    normalizer = _NORMALIZERS.get(flavor)
    if paths is None or normalizer is None:
        logger.warning(
            "website_sync: unknown flavor=%r for casa_id=%s — skipping",
            flavor, casa_id,
        )
        return (0, 0)
    config_path, girls_path = paths
    base_url = base.rstrip("/")

    # Config and girls are fetched INDEPENDENTLY: a girls failure must not throw
    # away a good config payload (rates/schedule). Only a config failure bails.
    try:
        config_resp = await http.get(
            base_url + config_path, timeout=_HTTP_TIMEOUT_S, headers=_SYNC_HEADERS
        )
        config_resp.raise_for_status()
        config = config_resp.json()
    except Exception:
        logger.warning(
            "website_sync: config fetch failed for casa_id=%s (%s, flavor=%s) — "
            "skipping", casa_id, base_url, flavor, exc_info=True,
        )
        return (0, 0)

    if not isinstance(config, dict):
        logger.warning(
            "website_sync: unexpected config shape for casa_id=%s (%s) — "
            "config=%s — skipping",
            casa_id, base_url, type(config).__name__,
        )
        return (0, 0)

    girls_payload: Any = None
    try:
        girls_resp = await http.get(
            base_url + girls_path, timeout=_HTTP_TIMEOUT_S, headers=_SYNC_HEADERS
        )
        girls_resp.raise_for_status()
        girls_payload = girls_resp.json()
    except Exception:
        logger.warning(
            "website_sync: girls fetch failed for casa_id=%s (%s, flavor=%s) — "
            "config will still sync, NO deactivation", casa_id, base_url, flavor,
            exc_info=True,
        )

    girls = (
        _girls_container(flavor, girls_payload)
        if girls_payload is not None else None
    )
    if girls is None and girls_payload is not None:
        logger.warning(
            "website_sync: unexpected girls shape for casa_id=%s (%s, "
            "flavor=%s) — payload=%s — config still synced, NO deactivation",
            casa_id, base_url, flavor, type(girls_payload).__name__,
        )

    try:
        await _sync_config(pool, casa_id, config)

        upserted = 0
        ext_ids: list[str] = []
        if girls:
            upserted, ext_ids = await _sync_girls(
                pool, casa_id, base_url, flavor, normalizer, girls
            )

        # Deactivate the absent half ONLY when at least one valid girl was
        # upserted (ext_ids non-empty). A non-empty-but-unusable feed yields
        # ext_ids=[] → no deactivation, so a degenerate/transient fetch can never
        # wipe the casa's roster (the deactivate query also no-ops on []).
        deactivated = 0
        if ext_ids:
            deactivated = await queries.deactivate_girls_not_in(
                pool, casa_id, ext_ids
            )
    except Exception:
        logger.warning(
            "website_sync: DB write failed for casa_id=%s (%s) — skipping",
            casa_id, base_url, exc_info=True,
        )
        return (0, 0)

    logger.info(
        "website_sync: casa_id=%s synced (flavor=%s) — girls_upserted=%d "
        "deactivated=%d", casa_id, flavor, upserted, deactivated,
    )
    return (upserted, deactivated)


async def _sync_config(
    pool: asyncpg.Pool, casa_id: int, config: dict
) -> None:
    """Mirror the config payload into casa_profile (preserving outcall pricing).

    Identical across flavors. Missing keys (whatsapp/telegram/faqs) degrade
    gracefully to None / []. Greetings only carry the languages actually present
    in the config so we never write a phantom None greeting for a missing lang."""
    site = config.get("site") or {}
    schedule = config.get("schedule") or {}
    greetings = {
        lang: site["greeting_" + lang]
        for lang in ("es", "en", "fr", "it")
        if site.get("greeting_" + lang) is not None
    }
    await queries.upsert_casa_profile_from_sync(
        pool,
        casa_id=casa_id,
        bot_name=site.get("bot_name"),
        whatsapp_recepcion=site.get("whatsapp_recepcion"),
        telegram_recepcion=site.get("telegram_recepcion"),
        greetings=greetings,
        rates=config.get("rates") or {},   # stored as-is JSONB
        schedule=schedule,                 # stored as-is JSONB
        faqs=config.get("faqs") or [],     # stored as-is JSONB
        address=schedule.get("address_es"),
        maps_url=schedule.get("maps_url"),
    )


async def _sync_girls(
    pool: asyncpg.Pool,
    casa_id: int,
    base_url: str,
    flavor: str,
    normalizer,
    girls: list,
) -> tuple[int, list[str]]:
    """Normalize + UPSERT each website girl; return (count_upserted, ext_ids)."""
    ext_ids: list[str] = []
    upserted = 0
    for raw in girls:
        if not isinstance(raw, dict):
            continue
        fields = normalizer(base_url, raw)
        if fields is None:
            # No usable id ⇒ can't key the partial-index upsert; skip it.
            continue
        await queries.upsert_girl_from_sync(
            pool,
            casa_id=casa_id,
            ext_id=fields["ext_id"],
            name=fields["name"],
            age=fields["age"],
            nationality=fields["nationality"],
            description=fields["description"],
            photo_url=fields["photo_url"],
            services=fields["services"],
            languages=fields["languages"],
            whatsapp=fields["whatsapp"],
            available_today=fields["available_today"],
            outcall=fields["outcall"],
            escort_pareja=fields["escort_pareja"],
        )
        ext_ids.append(fields["ext_id"])
        upserted += 1
    return (upserted, ext_ids)


async def sync_all(pool: asyncpg.Pool, http: httpx.AsyncClient) -> None:
    """Resolve every CASA_SITES keyword to a casa_id and sync it. Logs a summary
    (casas synced, girls upserted/deactivated, keywords skipped for no match).
    One unresolved keyword or one failing casa never aborts the run."""
    casas_synced = 0
    casas_skipped = 0
    total_upserted = 0
    total_deactivated = 0

    for keyword, site in CASA_SITES.items():
        # Per-casa isolation: even an unexpected error (e.g. the DB keyword
        # lookup) must skip only this casa, never abort the whole cron run.
        try:
            base = site.get("base")
            flavor = site.get("flavor", "chatbot")
            if not base:
                logger.warning(
                    "website_sync: CASA_SITES[%r] has no base URL — skipping",
                    keyword,
                )
                casas_skipped += 1
                continue

            casa_id = await queries.resolve_casa_id_by_keyword(pool, keyword)
            if casa_id is None:
                logger.warning(
                    "website_sync: no casa matched keyword=%r — skipping", keyword
                )
                casas_skipped += 1
                continue

            upserted, deactivated = await sync_casa(
                pool, http, casa_id, base, flavor
            )
            casas_synced += 1
            total_upserted += upserted
            total_deactivated += deactivated
        except Exception:
            logger.warning(
                "website_sync: unexpected error for keyword=%r — skipping",
                keyword, exc_info=True,
            )
            casas_skipped += 1
            continue

    logger.info(
        "website_sync: run complete — casas_synced=%d casas_skipped=%d "
        "girls_upserted=%d girls_deactivated=%d",
        casas_synced, casas_skipped, total_upserted, total_deactivated,
    )


async def website_sync_job(ctx: dict) -> None:
    """arq entrypoint (cron every ~20 min AND enqueueable on demand). Reuses the
    worker's asyncpg pool from ctx (never creates its own — see CLAUDE.md /
    worker conventions) and opens a short-lived httpx client scoped to the run,
    mirroring waha_health_check_job."""
    pool: asyncpg.Pool = ctx["kpi_db"]
    async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT_S) as http:
        await sync_all(pool, http)
