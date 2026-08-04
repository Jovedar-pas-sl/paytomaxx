"""Almacenamiento de fotos de chicas subidas a mano (agenda / Ficha del día).

Las fotos van a un volumen persistente (docker-compose: girl_media → /app/media)
y las sirve el app tras login (routes/media.py: GET /media/girls/<uuid>.<ext>).

Seguridad:
  * Se valida por MAGIC BYTES (nunca se confía en el content-type del cliente).
  * Nombre = uuid aleatorio + extensión de la lista blanca → no adivinable, sin
    control del cliente sobre la ruta.
  * `safe_media_path` acota el servido a _MEDIA_DIR (bloquea path traversal).
"""
from __future__ import annotations

import os
import re
import uuid

_MEDIA_DIR = os.environ.get("GIRL_MEDIA_DIR", "/app/media/girls")
_MAX_BYTES = 6 * 1024 * 1024  # 6 MB por foto
# Nombre servible: 32 hex (uuid4.hex) + extensión de la lista blanca.
_FILENAME_RE = re.compile(r"^[a-f0-9]{32}\.(jpg|png|webp)$")


def _ext_from_magic(head: bytes) -> str | None:
    """Extensión deducida de los primeros bytes (JPEG/PNG/WebP), o None."""
    if head.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    return None


async def save_girl_photo(upload) -> str | None:
    """Valida y persiste una foto subida. Devuelve la URL relativa del app
    (/media/girls/<uuid>.<ext>) o None si está vacía/no es una imagen válida.

    Lee el fichero acotado a _MAX_BYTES+1 (rechaza si excede) y olfatea los magic
    bytes — nunca confía en el content-type declarado por el navegador."""
    if upload is None or not getattr(upload, "filename", None):
        return None
    data = await upload.read(_MAX_BYTES + 1)
    if not data or len(data) > _MAX_BYTES:
        return None
    ext = _ext_from_magic(data[:16])
    if ext is None:
        return None
    os.makedirs(_MEDIA_DIR, exist_ok=True)
    fname = f"{uuid.uuid4().hex}.{ext}"
    with open(os.path.join(_MEDIA_DIR, fname), "wb") as f:
        f.write(data)
    return f"/media/girls/{fname}"


def safe_media_path(filename: str) -> str | None:
    """Resuelve una petición de servido a una ruta absoluta DENTRO de _MEDIA_DIR,
    o None si el nombre no es un `uuid.ext` válido (bloquea traversal + lecturas
    arbitrarias)."""
    if not _FILENAME_RE.match(filename or ""):
        return None
    path = os.path.join(_MEDIA_DIR, filename)
    real_dir = os.path.realpath(_MEDIA_DIR)
    if os.path.commonpath([os.path.realpath(path), real_dir]) != real_dir:
        return None
    return path
