"""Media proxy — streams media from WAHA to the authenticated browser.

WAHA stores attachments (images, videos, audio, documents) and exposes them
at URLs that require the `X-Api-Key` header. Browsers can't send that
header on a plain <img>/<video> src, so we proxy:

  GET /media/<message_id>  → streams the binary back with the stored mime.

Authentication: behind CurrentUser (same as the rest of the dashboard).
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, status
from fastapi.responses import Response, StreamingResponse

from app.deps import CurrentUser, KpiDB, Waha

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/media/{message_id}")
async def get_media(
    message_id: int,
    user: CurrentUser,  # noqa: ARG001 — auth side-effect
    kpi: KpiDB,
    waha: Waha,
) -> Response:
    async with kpi.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT media_url, media_mime FROM message WHERE id = $1",
            message_id,
        )

    if not row or not row["media_url"]:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Media no encontrado")

    mime = row["media_mime"] or "application/octet-stream"
    upstream = await waha.open_media_stream(row["media_url"])

    if upstream.status_code != 200:
        await upstream.aclose()
        logger.warning("waha media fetch failed: %s for msg=%s", upstream.status_code, message_id)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Media no disponible")

    async def _stream():
        try:
            async for chunk in upstream.aiter_bytes():
                yield chunk
        finally:
            await upstream.aclose()

    return StreamingResponse(
        _stream(),
        media_type=mime,
        headers={
            # Allow browser caching — media immutable per message
            "Cache-Control": "private, max-age=86400",
        },
    )
