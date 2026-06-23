"""Tests for the deterministic markdown-stripping of outgoing replies.

WhatsApp renders markdown literally, so '**Cloe**' must never reach the client.
"""

from app.agent.reply_engine import _strip_formatting


def test_removes_double_and_single_asterisks():
    assert _strip_formatting("aquí tengo a **Cloe**") == "aquí tengo a Cloe"
    assert _strip_formatting("es *muy* guapa") == "es muy guapa"


def test_keeps_emoji_accents_and_normal_text():
    txt = "siii cariño 😘 ¿a qué hora te viene? 💋"
    assert _strip_formatting(txt) == txt


def test_keeps_euro_breakdown_intact():
    assert _strip_formatting("el domicilio son 150€ + 40€ de taxi") == "el domicilio son 150€ + 40€ de taxi"


def test_removes_backticks_and_headers():
    assert _strip_formatting("`hola`") == "hola"
    assert _strip_formatting("# Título\ntexto") == "Título\ntexto"


def test_none_and_empty_passthrough():
    assert _strip_formatting("") == ""
    assert _strip_formatting(None) is None
