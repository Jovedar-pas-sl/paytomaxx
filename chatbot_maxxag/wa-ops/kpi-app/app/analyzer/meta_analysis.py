"""Meta-analysis Claude skill: takes N compact conversation summaries,
detects patterns, strengths, improvements, and typical client profile."""

from __future__ import annotations

import logging

from app.analyzer import prompts
from app.analyzer.skills import _call_json  # reuse the Claude call helper
from app.models import BlockAnalysisResult

logger = logging.getLogger("analyzer.meta_analysis")

# Per-transcript char cap and overall prompt budget for the block analyzer.
# ~1500 chars/conv keeps each transcript readable; ~60k total stays well under
# Haiku's context while leaving headroom for the system prompt + JSON output.
_BLOCK_PER_CONV_CHARS = 1500
_BLOCK_TOTAL_CHARS = 60_000


async def run_block_analysis(
    scope_name: str, transcripts: list[tuple[int, str]]
) -> BlockAnalysisResult:
    """Build a casa/number informe by reading conversation TRANSCRIPTS directly
    in ONE batch Claude call — no per-conversation analysis required.

    ``transcripts`` is a list of ``(conv_id, text)``. Each text is truncated to
    ~1500 chars and the TOTAL prompt is capped at ~60k chars. When the combined
    size would exceed the cap, conversations are sampled EVENLY across the list
    (preserving recency spread) and the sampling is logged + noted in the header.
    """
    total_convs = len(transcripts)

    # ── Even sampling when the corpus is too big to fit the char budget ──
    # Estimate per-conv footprint after truncation, then derive how many fit.
    max_fit = max(1, _BLOCK_TOTAL_CHARS // (_BLOCK_PER_CONV_CHARS + 40))
    sampled = transcripts
    note = ""
    if total_convs > max_fit:
        step = total_convs / max_fit
        idxs = sorted({int(i * step) for i in range(max_fit)})
        sampled = [transcripts[i] for i in idxs if i < total_convs]
        note = (
            f"NOTA: hay {total_convs} conversaciones; se han tomado "
            f"{len(sampled)} repartidas de forma uniforme para que quepan."
        )
        logger.info(
            "block_analysis: sampling %d/%d transcripts to fit char budget",
            len(sampled), total_convs,
        )

    header = [
        f"Ámbito: {scope_name}",
        f"Conversaciones incluidas: {len(sampled)}"
        + (f" (de {total_convs} totales)" if note else ""),
    ]
    if note:
        header.append(note)
    header.append("")

    parts: list[str] = ["\n".join(header)]
    used = len(parts[0])
    for conv_id, text in sampled:
        body = (text or "")[:_BLOCK_PER_CONV_CHARS]
        block = f"=== conv {conv_id} ===\n{body}"
        # Hard stop if we somehow blow past the total budget (defensive).
        if used + len(block) + 1 > _BLOCK_TOTAL_CHARS:
            break
        parts.append(block)
        used += len(block) + 1

    user_content = "\n".join(parts)

    # BlockAnalysisResult is the richest schema we generate: summary +
    # strengths + improvements + client_profile (≤2000 chars) + top_topics +
    # top_referrals + red_flags (an unbounded-feeling list, capped at 20).
    # Entrega 2 adds the MONEY block (funnel + confirmed_* + revenue +
    # lost_reasons + top_chicas + top_services + upsell + channel_roi), all in
    # this SAME single call — so the output JSON is materially bigger now.
    # Worst-case structured JSON can exceed 3500 tokens; _call_json raises
    # RuntimeError on stop_reason == "max_tokens", which would silently drop
    # the whole informe. Bumped to 4000 for defensive headroom over the
    # new ceiling without materially raising cost. Schema (and thus the new
    # money fields) is derived from BlockAnalysisResult, so no logic change.
    data = await _call_json(
        system=prompts.BLOCK_PROMPT,
        user=user_content,
        schema=BlockAnalysisResult.model_json_schema(),
        max_tokens=4000,
        timeout=120.0,
    )
    return BlockAnalysisResult.model_validate(data)
