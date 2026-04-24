# syntax=docker/dockerfile:1.7
# ══════════════════════════════════════════════════════════════════
# Multi-stage: install deps as non-root in a slim base, copy to final.
# ══════════════════════════════════════════════════════════════════

# ── Stage 1: builder (install deps) ───────────────────────────────
FROM python:3.12-slim AS builder

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /build

# Install build deps only (removed in final stage)
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        libpq-dev \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml ./
RUN pip install --upgrade pip && pip install --prefix=/install .

# ── Stage 2: runtime ──────────────────────────────────────────────
FROM python:3.12-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH=/install/bin:$PATH \
    PYTHONPATH=/install/lib/python3.12/site-packages

# Runtime deps (libpq for asyncpg, curl/wget for healthcheck)
RUN apt-get update && apt-get install -y --no-install-recommends \
        libpq5 \
        wget \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1000 appuser

# Copy installed packages
COPY --from=builder /install /install

WORKDIR /app
COPY --chown=appuser:appuser alembic.ini ./
COPY --chown=appuser:appuser alembic ./alembic
COPY --chown=appuser:appuser app ./app
COPY --chown=appuser:appuser entrypoint.sh ./
RUN chmod +x entrypoint.sh

USER appuser
EXPOSE 5000

# Entrypoint runs migrations (only when ROLE=web) then starts the correct process.
CMD ["./entrypoint.sh"]
