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


class MetaAnalysisResult(BaseModel):
    summary: str = Field(..., max_length=300)
    patterns: list[Pattern] = Field(..., min_length=1, max_length=10)
    strengths: list[str] = Field(..., min_length=1, max_length=8)
    improvements: list[str] = Field(..., min_length=1, max_length=8)
    client_profile: str = Field(..., max_length=600)


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


async def run_meta_analysis(
    casa_name: str, summaries: list[ConvSummary]
) -> MetaAnalysisResult:
    """Run meta-analysis over compact summaries. Returns structured result."""
    lines = [f"Casa: {casa_name}", f"Conversaciones analizadas: {len(summaries)}", ""]
    for s in summaries:
        lines.append(
            f"#{s.conv_id} mood={s.mood}({s.mood_score}/10) "
            f"trato[car={s.treat_carinoso} pro={s.treat_profesional} "
            f"vend={s.treat_vendedor} seco={s.treat_seco}] "
            f"conv={int(s.conv_probability * 100)}% "
            f"\"{s.first_client_line[:70]}\""
        )
    user_content = "\n".join(lines)

    data = await _call_json(
        system=prompts.META_PROMPT,
        user=user_content,
        schema=MetaAnalysisResult.model_json_schema(),
    )
    return MetaAnalysisResult.model_validate(data)
