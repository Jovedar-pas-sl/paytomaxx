"""Unit tests for the dependency-free reply-language detector."""

import pytest

from app.agent.lang_detect import detect_lang


@pytest.mark.parametrize(
    "text,expected",
    [
        # Spanish — greetings + intents (es is also the default, so it's fine to
        # return it; these assert the detector positively recognizes Spanish).
        ("hola guapo", "es"),
        ("cuánto cuesta esta noche?", "es"),
        ("quiero reservar una chica", "es"),
        # English
        ("hi how much for tonight?", "en"),
        ("hello are you available?", "en"),
        ("i want to book a girl", "en"),
        # French
        ("salut, combien ce soir?", "fr"),
        ("bonjour je veux réserver une fille", "fr"),
        ("coucou quelle heure?", "fr"),
        # Italian
        ("ciao quanto costa stasera?", "it"),
        ("buongiorno vorrei prenotare", "it"),
        ("ciao bella, che ora?", "it"),
    ],
)
def test_detects_clear_language(text, expected):
    assert detect_lang(text) == expected


@pytest.mark.parametrize(
    "text",
    [
        "",
        "   ",
        "ok",
        "👍",
        "👍😘",
        "777",
        "...",
    ],
)
def test_ambiguous_or_empty_returns_none(text):
    # Too short / no language signal → None so the caller keeps the casa default.
    assert detect_lang(text) is None


def test_accent_folding_detects_accented_input():
    # Accented French input must still be detected (clients drop/keep accents).
    assert detect_lang("Combien pour ce soir, chéri?") == "fr"


def test_spanish_not_flipped_by_one_shared_token():
    # 'disponible' exists in both es and fr; a clearly-Spanish message must NOT
    # be flipped to French by that single shared token.
    assert detect_lang("hola, está disponible hoy?") == "es"


def test_italian_quanto_not_confused_with_spanish_cuanto():
    # it 'quanto' and es 'cuanto' fold to different stems — no cross-trigger.
    assert detect_lang("quanto costa?") == "it"
    assert detect_lang("cuanto cuesta?") == "es"
