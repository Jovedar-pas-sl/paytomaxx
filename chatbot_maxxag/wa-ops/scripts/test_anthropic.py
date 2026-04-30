"""Diagnóstico Anthropic API key + estructura de request.

Ejecutar dentro del contenedor kpi-worker tras rotar key:

    docker cp scripts/test_anthropic.py maxxag-wa-ops-kpi-worker-1:/tmp/test.py
    docker exec maxxag-wa-ops-kpi-worker-1 python /tmp/test.py
"""
import asyncio
import os
import sys
from anthropic import AsyncAnthropic


async def main() -> None:
    key = os.environ.get("ANTHROPIC_API_KEY", "")
    print(f"Key prefix: {key[:18]}...  len={len(key)}")
    if not key:
        print("FAIL: ANTHROPIC_API_KEY not set in env")
        sys.exit(1)

    client = AsyncAnthropic()

    # Test 1: minimal request (no structured output)
    print("\n--- Test 1: minimal ---")
    try:
        r = await client.messages.create(
            model="claude-haiku-4-5",
            max_tokens=50,
            messages=[{"role": "user", "content": "Di hola en una palabra."}],
        )
        print("OK:", r.content[0].text)
    except Exception as e:
        print(f"ERR type: {type(e).__name__}")
        print(f"ERR str: {str(e)[:800]}")
        body = getattr(e, "body", None)
        if body:
            print(f"ERR body: {body}")
        return

    # Test 2: structured output (output_config) — this is what our skills use
    print("\n--- Test 2: structured output ---")
    try:
        r = await client.messages.create(
            model="claude-haiku-4-5",
            max_tokens=200,
            system="Returns a greeting object",
            messages=[{"role": "user", "content": "Saluda."}],
            output_config={
                "format": {
                    "type": "json_schema",
                    "schema": {
                        "type": "object",
                        "additionalProperties": False,
                        "properties": {"greeting": {"type": "string"}},
                        "required": ["greeting"],
                    },
                }
            },
        )
        print("OK:", r.content[0].text)
    except Exception as e:
        print(f"ERR type: {type(e).__name__}")
        print(f"ERR str: {str(e)[:800]}")
        body = getattr(e, "body", None)
        if body:
            print(f"ERR body: {body}")


asyncio.run(main())
