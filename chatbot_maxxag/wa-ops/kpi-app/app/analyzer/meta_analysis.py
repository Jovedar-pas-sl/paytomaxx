"""Meta-analysis Claude skill: takes N compact conversation summaries,
detects patterns, strengths, improvements, and typical client profile."""

from __future__ import annotations

import json
from typing import Literal

from pydantic import BaseModel, Field

from app.analyzer import prompts
from app.analyzer.skills import _call_json  # reuse the Claude call helper


class Pattern(BaseModel):
    description: str
    frequency: Literal["alta", "media", "baja"]


class TopicShare(BaseModel):
    """One topic + how often it appears in the sample."""
    topic: str
    count: int           # number of conversations where it appears
    pct: float           # percentage of the sample (0-100)


class ReferralShare(BaseModel):
    """Distribution of referral sources within the sample."""
    source: str          # e.g. "Loquosex", "Mileróticos", "Google", "Word-of-mouth", "Unknown"
    count: int
    pct: float


class MetaAnalysisResult(BaseModel):
    # Limits raised to match the rebalanced META_PROMPT (richer summary +
    # client_profile, fewer patterns). Generous max_length leaves margin
    # for Claude to occasionally exceed the suggested target without the
    # whole report failing.
    summary: str = Field(..., max_length=1500)
    patterns: list[Pattern] = Field(..., min_length=1, max_length=10)
    strengths: list[str] = Field(..., min_length=1, max_length=8)
    improvements: list[str] = Field(..., min_length=1, max_length=8)
    client_profile: str = Field(..., max_length=2000)
    # New per-WA fields — populated when enough data is available, otherwise empty.
    top_topics: list[TopicShare] = Field(default_factory=list, max_length=10)
    avoided_topics: list[str] = Field(default_factory=list, max_length=8)
    top_referrals: list[ReferralShare] = Field(default_factory=list, max_length=6)


class ConvSummary(BaseModel):
    conv_id: int
    mood: str
    mood_score: int
    treat_carinoso: int
    treat_profesional: int
    treat_vendedor: int
    treat_seco: int
    conv_probability: float
    first_client_line: str
    # Optional enrichment — used by the per-WA meta prompt to compute
    # topic + referral distribution. Empty/None for legacy callers.
    intent_primary: str | None = None
    rt_p50_ms: int | None = None
    rt_p90_ms: int | None = None
    referral_kind: str | None = None
    referral_name: str | None = None


async def run_meta_analysis(
    casa_name: str, summaries: list[ConvSummary]
) -> MetaAnalysisResult:
    """Run meta-analysis over compact summaries. Returns structured result."""
    lines = [
        f"Casa: {casa_name}",
        f"Conversaciones analizadas: {len(summaries)}",
        "",
        "Formato por línea: #conv_id mood(score/10) trato[car/pro/vend/seco] conv% rt_p50_ms intent referral primer_msg",
        "",
    ]
    for s in summaries:
        rt_p50 = s.rt_p50_ms if s.rt_p50_ms is not None else "-"
        intent = s.intent_primary or "-"
        ref = (
            f"{s.referral_kind}:{s.referral_name}"
            if s.referral_kind and s.referral_name
            else (s.referral_kind or "-")
        )
        lines.append(
            f"#{s.conv_id} mood={s.mood}({s.mood_score}/10) "
            f"trato[car={s.treat_carinoso} pro={s.treat_profesional} "
            f"vend={s.treat_vendedor} seco={s.treat_seco}] "
            f"conv={int(s.conv_probability * 100)}% "
            f"rt_p50={rt_p50}ms intent={intent} ref={ref} "
            f"\"{s.first_client_line[:70]}\""
        )
    user_content = "\n".join(lines)

    # Meta needs much more output budget than the per-skill default (800):
    # summary + 3-6 patterns + 3-5 strengths + 3-5 improvements + client_profile
    # + 3-6 top_topics + 1-4 avoided_topics + 2-5 top_referrals = easily 3-4k tokens.
    # 60s timeout covers Haiku generating that volume.
    # Meta uses near the Haiku 4.5 max output (8192). Plenty of headroom for
    # the largest informes (50+ convs with rich top_topics/top_referrals).
    data = await _call_json(
        system=prompts.META_PROMPT,
        user=user_content,
        schema=MetaAnalysisResult.model_json_schema(),
        max_tokens=8000,
        timeout=120.0,
    )
    return MetaAnalysisResult.model_validate(data)
