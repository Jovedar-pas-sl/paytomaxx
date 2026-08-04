"""Tests for girl-photo upload storage + safe serving (app/girl_media.py).

Pure/fs-isolated: _MEDIA_DIR is monkeypatched to a tmp dir so nothing touches
/app. Covers magic-byte sniffing (never trust content-type), the uuid.ext serve
allowlist (path-traversal blocked), and the upload validation/persist path.
"""
from __future__ import annotations

import pytest

from app import girl_media


# ── _ext_from_magic ──────────────────────────────────────────────────
def test_magic_detects_jpeg_png_webp():
    assert girl_media._ext_from_magic(b"\xff\xd8\xff\xe0\x00\x10JFIF") == "jpg"
    assert girl_media._ext_from_magic(b"\x89PNG\r\n\x1a\n\x00\x00") == "png"
    assert girl_media._ext_from_magic(b"RIFF\x24\x00\x00\x00WEBPVP8 ") == "webp"


@pytest.mark.parametrize("head", [b"GIF89a", b"<?php echo 1;", b"MZ\x90\x00", b"", b"RIFFxxxxAVI "])
def test_magic_rejects_non_images(head):
    assert girl_media._ext_from_magic(head) is None


# ── safe_media_path (serve allowlist) ────────────────────────────────
def test_safe_path_accepts_uuid_ext(tmp_path, monkeypatch):
    monkeypatch.setattr(girl_media, "_MEDIA_DIR", str(tmp_path))
    p = girl_media.safe_media_path("0123456789abcdef0123456789abcdef.jpg")
    assert p is not None and p.endswith(".jpg")


@pytest.mark.parametrize("name", [
    "../../etc/passwd",          # traversal
    "evil.php",                  # bad ext + not uuid
    "0123.jpg",                  # too short
    "0123456789abcdef0123456789abcdef.gif",   # ext not allowed
    "0123456789ABCDEF0123456789abcdef.jpg",   # uppercase not in [a-f0-9]
    "../0123456789abcdef0123456789abcdef.jpg",
    "",
])
def test_safe_path_rejects_bad_names(name, tmp_path, monkeypatch):
    monkeypatch.setattr(girl_media, "_MEDIA_DIR", str(tmp_path))
    assert girl_media.safe_media_path(name) is None


# ── save_girl_photo (validate + persist) ─────────────────────────────
class _Upload:
    def __init__(self, data: bytes, filename: str | None = "x.jpg"):
        self._data = data
        self.filename = filename

    async def read(self, n: int) -> bytes:
        return self._data


async def test_save_photo_persists_valid_jpeg(tmp_path, monkeypatch):
    monkeypatch.setattr(girl_media, "_MEDIA_DIR", str(tmp_path))
    url = await girl_media.save_girl_photo(_Upload(b"\xff\xd8\xff\xe0" + b"\x00" * 200))
    assert url and url.startswith("/media/girls/") and url.endswith(".jpg")
    # the file was actually written into the media dir
    assert any(p.suffix == ".jpg" for p in tmp_path.iterdir())


async def test_save_photo_rejects_non_image(tmp_path, monkeypatch):
    monkeypatch.setattr(girl_media, "_MEDIA_DIR", str(tmp_path))
    assert await girl_media.save_girl_photo(_Upload(b"not an image at all")) is None


async def test_save_photo_rejects_empty_and_missing_filename(tmp_path, monkeypatch):
    monkeypatch.setattr(girl_media, "_MEDIA_DIR", str(tmp_path))
    assert await girl_media.save_girl_photo(_Upload(b"", filename="x.jpg")) is None
    assert await girl_media.save_girl_photo(_Upload(b"\xff\xd8\xff", filename=None)) is None
    assert await girl_media.save_girl_photo(None) is None


async def test_save_photo_rejects_oversize(tmp_path, monkeypatch):
    monkeypatch.setattr(girl_media, "_MEDIA_DIR", str(tmp_path))
    big = b"\xff\xd8\xff" + b"\x00" * (girl_media._MAX_BYTES + 10)
    assert await girl_media.save_girl_photo(_Upload(big)) is None
