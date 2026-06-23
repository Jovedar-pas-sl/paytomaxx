"""Unit tests for the style-example harvest (Wave 2): scrub/dedup/classify +
the persona style block. Pure logic only — no DB."""

from app.agent import persona, style_harvest
from app.agent.style_harvest import Candidate, build_candidate, dedup_key, scrub
from app.queries import HarvestedReply


# ── scrub ────────────────────────────────────────────────────────────
def test_scrub_strips_phone_url_tags_and_collapses_ws():
    out = scrub("hola   <b>cariño</b> escribe a https://x.com o al +34 600 123 456 😘", 240)
    assert "http" not in out
    assert "<b>" not in out and "</b>" not in out
    assert "600" not in out  # phone-like run redacted
    assert "  " not in out   # whitespace collapsed
    assert "cariño" in out and "😘" in out  # tone preserved


def test_scrub_truncates_to_maxlen():
    assert len(scrub("a" * 500, 240)) == 240


def test_scrub_empty():
    assert scrub("", 240) == ""


# ── dedup_key ──────────────────────────────────────────────────────────
def test_dedup_key_folds_accents_case_and_spacing():
    assert dedup_key("Sí Cariño  💋") == dedup_key("si carino 💋")


# ── build_candidate ────────────────────────────────────────────────────
def test_build_candidate_pair_with_lang():
    h = HarvestedReply(reply_msg="siii guapo, te la reservo 😏", client_msg="hola cuanto cuesta")
    cand = build_candidate(h)
    assert isinstance(cand, Candidate)
    assert cand.kind == "pair"
    assert cand.client_msg is not None
    assert cand.lang == "es"
    assert cand.dedup_key


def test_build_candidate_phrase_when_no_client():
    h = HarvestedReply(reply_msg="te la dejo lista cielo 💋", client_msg=None)
    cand = build_candidate(h)
    assert cand is not None and cand.kind == "phrase" and cand.client_msg is None


def test_build_candidate_rejects_too_short():
    assert build_candidate(HarvestedReply(reply_msg="ok", client_msg=None)) is None


def test_build_candidate_rejects_too_long():
    long_reply = "x" * (style_harvest._REPLY_MAX + 1)
    assert build_candidate(HarvestedReply(reply_msg=long_reply, client_msg=None)) is None


def test_build_candidate_rejects_empty_after_scrub():
    # A reply that is only a URL scrubs to nothing → not a usable example.
    assert build_candidate(HarvestedReply(reply_msg="https://example.com/aaaa", client_msg=None)) is None


# ── persona.build_style_block ──────────────────────────────────────────
def test_style_block_empty_is_blank():
    assert persona.build_style_block([], "es") == ""


def test_style_block_renders_pair_and_phrase():
    block = persona.build_style_block(
        [("hola", "siii guapo 😏"), (None, "te la dejo lista 💋")], "es"
    )
    assert "ASÍ RESPONDE EL EQUIPO" in block
    assert 'Cliente: "hola" → "siii guapo 😏"' in block
    assert '- "te la dejo lista 💋"' in block


def test_style_block_unknown_lang_falls_back_to_es_label():
    block = persona.build_style_block([(None, "hi babe")], "xx")
    assert "ASÍ RESPONDE EL EQUIPO" in block


def test_style_block_skips_rows_with_empty_reply():
    block = persona.build_style_block([(None, ""), ("q", "real reply here")], "es")
    assert "real reply here" in block
    assert block.count("\n- ") == 0  # the empty-reply phrase row is dropped


# ── relevance ranking (Wave 2 learning loop) ──────────────────────────
from app.queries import StyleSample, rank_style_samples  # noqa: E402


def test_rank_prefers_relevant_example():
    s = [
        StyleSample("pair", "hola cuanto cuesta", "la hora 150"),
        StyleSample("pair", "haces griego?", "eso es un extra de 30"),
        StyleSample("phrase", None, "te la dejo lista"),
    ]
    out = rank_style_samples(s, "oye haces griego o beso negro?", limit=1)
    assert out[0].client_msg == "haces griego?"


def test_rank_falls_back_to_order_when_no_incoming():
    s = [StyleSample("phrase", None, "a"), StyleSample("phrase", None, "b")]
    assert rank_style_samples(s, "", limit=1) == s[:1]


def test_rank_returns_input_when_fewer_than_limit():
    s = [StyleSample("pair", "hola", "hey")]
    assert rank_style_samples(s, "cuanto cuesta", limit=6) == s
