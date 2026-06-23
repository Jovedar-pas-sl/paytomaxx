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

# ── Stage 1b: compile Tailwind CSS (standalone CLI — no Node) ─────
# Replaces the in-browser Tailwind Play CDN with a precompiled, minified
# stylesheet served from /static. Scans the templates for classes using the
# ported tailwind.config.js. Output copied into the runtime image below.
FROM debian:bookworm-slim AS css
WORKDIR /work
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL -o /usr/local/bin/tailwindcss \
       https://github.com/tailwindlabs/tailwindcss/releases/download/v3.4.17/tailwindcss-linux-x64 \
    && chmod +x /usr/local/bin/tailwindcss
COPY tailwind.config.js ./
COPY app/templates ./app/templates
COPY app/static/css/input.css ./app/static/css/input.css
RUN tailwindcss -c tailwind.config.js -i app/static/css/input.css -o app/static/css/app.css --minify \
    && test -s app/static/css/app.css

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
# Precompiled Tailwind CSS from the `css` stage (overwrites nothing else).
COPY --from=css --chown=appuser:appuser /work/app/static/css/app.css ./app/static/css/app.css
COPY --chown=appuser:appuser entrypoint.sh ./
RUN chmod +x entrypoint.sh

USER appuser
EXPOSE 5000

# Entrypoint runs migrations (only when ROLE=web) then starts the correct process.
CMD ["./entrypoint.sh"]
