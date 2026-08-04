"""Lightweight, dependency-free language detector for the reply agent.

Detects which of the 4 supported reply languages (es / en / fr / it) a client is
writing in, so Sara can answer in the client's language instead of always the
casa default. Tuned for SHORT WhatsApp openers and intents — 'hola' / 'hi' /
'salut' / 'ciao', 'cuánto' / 'how much' / 'combien' / 'quanto' — which is what
the vast majority of first contacts look like.

CONSERVATIVE BY DESIGN: returns a code ONLY when there is a clear, non-ambiguous
signal that clears a margin over the runner-up; otherwise returns None so the
caller falls back to the casa default (replying in the wrong language is worse
than defaulting). Pure + side-effect free. No model download, no network.
"""

from __future__ import annotations

import re
import unicodedata

# The 4 languages the persona templates exist for (see app.agent.persona).
SUPPORTED: tuple[str, ...] = ("es", "en", "fr", "it")

# Minimum winning score, and minimum margin over the runner-up, for a confident
# detection. A single shared/low-weight token must NOT be enough to flip the
# language — that is what the margin guards against.
_MIN_SCORE = 2
_MIN_MARGIN = 2

# Per-language marker → weight. Matched as whole words on the ACCENT-FOLDED,
# lowercased text, so keywords are written folded (e.g. 'cuanto', 'reserver').
# Weights: 3-4 = strong/distinctive (greetings, intents), 1-2 = supporting.
_MARKERS: dict[str, tuple[tuple[str, int], ...]] = {
    "es": (
        ("hola", 3), ("buenas", 3), ("buenos dias", 3), ("buenas noches", 2),
        ("cuanto", 3), ("cuanto cuesta", 4), ("esta noche", 3), ("quiero", 2),
        ("reservar", 3), ("chica", 2), ("chicas", 2), ("disponible", 2),
        ("disponibles", 2), ("que hora", 3), ("como estas", 3), ("donde", 2),
        ("gracias", 1), ("hoy", 1), ("para", 1), ("eres", 2), ("tienes", 2),
        ("guapa", 1), ("precio", 1), ("precios", 1), ("fotos", 1), ("abierto", 1),
        ("ahora", 1),
    ),
    "en": (
        ("hi", 2), ("hello", 3), ("hey", 2), ("good morning", 3), ("how much", 4),
        ("how are you", 3), ("tonight", 3), ("available", 3), ("book", 2),
        ("booking", 3), ("girl", 2), ("girls", 2), ("price", 2), ("prices", 2),
        ("pics", 2), ("what time", 3), ("are you", 2), ("do you", 2), ("where", 2),
        ("i want", 3), ("please", 1), ("thanks", 1), ("thank you", 2), ("the", 1),
        ("you", 1), ("your", 1), ("have", 1), ("for", 1), ("how", 1), ("today", 1),
        ("send", 1), ("open", 1), ("now", 1),
    ),
    "fr": (
        ("salut", 3), ("bonjour", 3), ("bonsoir", 3), ("coucou", 3), ("combien", 4),
        ("quelle heure", 4), ("ce soir", 3), ("je veux", 3), ("reserver", 3),
        ("fille", 2), ("filles", 2), ("disponible", 2), ("disponibles", 2),
        ("ca va", 3), ("merci", 1), ("bonne", 1), ("t es", 2), ("tu es", 2),
        ("je voudrais", 3), ("combien ca coute", 4), ("maintenant", 1),
    ),
    "it": (
        ("ciao", 3), ("buongiorno", 3), ("buonasera", 3), ("salve", 2),
        ("quanto", 3), ("quanto costa", 4), ("stasera", 3), ("vorrei", 3),
        ("prenotare", 3), ("ragazza", 2), ("ragazze", 2), ("disponibile", 2),
        ("disponibili", 2), ("che ora", 3), ("come stai", 3), ("dove", 2),
        ("grazie", 1), ("bella", 1), ("sei", 2), ("vuoi", 1), ("adesso", 1),
    ),
}


def _fold(text: str) -> str:
    """Lowercase + strip accents/diacritics (NFKD → drop combining marks).

    Folding lets a single keyword list match both accented and unaccented client
    spellings (clients routinely drop accents on mobile), while the distinctive
    STEMS still differ across languages (es 'reservar' vs fr 'reserver', es
    'cuanto' vs it 'quanto')."""
    nfkd = unicodedata.normalize("NFKD", text.lower())
    return "".join(c for c in nfkd if not unicodedata.combining(c))


def detect_lang(text: str) -> str | None:
    """Detect the language of `text` as one of SUPPORTED, or None if unsure.

    Scores each language by its matched markers (whole-word on the folded text)
    and returns the top language only when it clears `_MIN_SCORE` AND beats the
    runner-up by at least `_MIN_MARGIN`. Returns None for empty/too-short/ambiguous
    input so the caller keeps the casa default. Pure + side-effect free."""
    if not text:
        return None
    folded = _fold(text)
    if not folded.strip():
        return None

    scores: dict[str, int] = {lang: 0 for lang in SUPPORTED}
    for lang, markers in _MARKERS.items():
        for kw, weight in markers:
            # \b is unreliable around folded multibyte; use explicit non-word
            # lookarounds so 'hi' doesn't match inside 'chica', etc.
            if re.search(rf"(?<!\w){re.escape(kw)}(?!\w)", folded):
                scores[lang] += weight

    ranked = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
    (best_lang, best_score) = ranked[0]
    runner_up_score = ranked[1][1] if len(ranked) > 1 else 0
    if best_score < _MIN_SCORE or (best_score - runner_up_score) < _MIN_MARGIN:
        return None
    return best_lang
