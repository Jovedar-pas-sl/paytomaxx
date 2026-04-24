# NotebookLM — Consulta rápida de docs

**No es un componente del sistema.** Es una herramienta personal para ti
durante desarrollo/operación: subes las docs oficiales a un notebook Google
NotebookLM y haces preguntas como si fuera un experto local.

## Setup (una vez, ~5 min)

1. Ve a https://notebooklm.google.com con la cuenta Google que uses habitualmente.
2. Crea un nuevo notebook llamado **"Maxxag WA Ops"**.
3. **Add sources** → pega las URLs siguientes (NotebookLM las descarga, indexa y las cita en respuestas):

   ### Chatwoot
   - https://www.chatwoot.com/docs/self-hosted/deployment/docker
   - https://www.chatwoot.com/docs/product/channels/evolution-api
   - https://www.chatwoot.com/docs/product/features/webhooks
   - https://www.chatwoot.com/docs/product/features/conversations

   ### Evolution API v2
   - https://doc.evolution-api.com/v2/pt/get-started/introduction
   - https://doc.evolution-api.com/v2/pt/install/docker
   - https://doc.evolution-api.com/v2/pt/env
   - https://doc.evolution-api.com/v2/pt/events/webhook

   ### Claude Haiku 4.5 (para futuras tweaks al analyzer)
   - https://platform.claude.com/docs/en/about-claude/models/overview
   - https://platform.claude.com/docs/en/build-with-claude/prompt-caching

   ### Docs propias
   - Tu `docs/RUNBOOK.md` exportado (copia-pega el contenido a un archivo y súbelo).

## Cómo se usa

Ejemplos de preguntas que respondería bien:

> "¿Cómo rotar el `SECRET_KEY_BASE` de Chatwoot sin perder sesiones existentes?"

> "¿Qué variable de Evolution API controla el tamaño máximo de las cargas de webhook?"

> "¿Qué evento de Chatwoot se dispara cuando un agente asigna un conversation a sí mismo?"

NotebookLM responde con citas directas a los párrafos exactos de la doc.

## Por qué no es parte del sistema

- Los datos sensibles (conversaciones reales de clientes) **NUNCA** se suben a NotebookLM — solo docs públicas.
- Es asíncrono y personal — nadie en producción consulta esto en caliente.
- Cuando NotebookLM no esté disponible o cambie de condiciones de servicio, el sistema sigue funcionando sin romperse.

## Alternativas

Si prefieres no usar NotebookLM (gratis pero con cuenta Google):
- Bookmarks del navegador a las URLs de arriba
- Descargar las docs en markdown local con `wget --mirror`
- Claude Code con las URLs en context (este CLI)
