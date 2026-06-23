# Deploy — Mejoras del bot (idioma · aprender de encargadas · 2 globos · conversión · A/B)

Hecho y **testeado** (369 passed, 0 fallos). Despliega todo de una. Incluye 2 migraciones nuevas (0019, 0020).

## Qué entra

| # | Feature | Resumen |
|---|---------|---------|
| 2 | **Detección de idioma** | Sara detecta es/en/fr/it del mensaje del cliente y responde en el suyo (conservador → si dudoso, default de la casa). |
| 3 | **Aprende de las encargadas** | Cron nocturno muestrea respuestas humanas reales por casa → `pendientes` → las apruebas en **Ajustes → Entrenamiento de Sara** → las aprobadas se inyectan como "ASÍ RESPONDE EL EQUIPO". |
| 6 | **2 globos** | Respuestas largas se parten en 2 mensajes (en límite de frase, nunca en "..."), con pausa humana entre medias. Cada globo respeta el anti-ban. |
| 7 | **Conversión** | Botón **"Marcar reservado"** en cada conversación (toggle). Es la señal de conversión. |
| 7 | **A/B de saludos** | A cada conversación nueva se le asigna 1 de 3 estilos de saludo (directa/coqueta/curiosa) en el 1er mensaje; el % de conversión por estilo se ve en Entrenamiento. |

(La transcripción de voz queda aparcada para el futuro, como acordamos.)

## 1) Subir ficheros (desde tu PC, en la raíz del repo)

```powershell
cd C:\Users\mehdi\Documents\GitHub\first_tries

# agent
scp chatbot_maxxag\wa-ops\kpi-app\app\agent\lang_detect.py chatbot_maxxag\wa-ops\kpi-app\app\agent\style_harvest.py chatbot_maxxag\wa-ops\kpi-app\app\agent\persona.py chatbot_maxxag\wa-ops\kpi-app\app\agent\reply_engine.py chatbot_maxxag\wa-ops\kpi-app\app\agent\auto_reply.py root@72.62.190.116:/opt/wa-ops/kpi-app/app/agent/

# analyzer (cron) + app root
scp chatbot_maxxag\wa-ops\kpi-app\app\analyzer\worker.py root@72.62.190.116:/opt/wa-ops/kpi-app/app/analyzer/
scp chatbot_maxxag\wa-ops\kpi-app\app\queries.py chatbot_maxxag\wa-ops\kpi-app\app\main.py root@72.62.190.116:/opt/wa-ops/kpi-app/app/

# routes
scp chatbot_maxxag\wa-ops\kpi-app\app\routes\conversation.py chatbot_maxxag\wa-ops\kpi-app\app\routes\style_routes.py root@72.62.190.116:/opt/wa-ops/kpi-app/app/routes/

# migraciones
scp chatbot_maxxag\wa-ops\kpi-app\alembic\versions\0019_style_examples.py chatbot_maxxag\wa-ops\kpi-app\alembic\versions\0020_conversion_ab.py root@72.62.190.116:/opt/wa-ops/kpi-app/alembic/versions/

# plantillas
scp chatbot_maxxag\wa-ops\kpi-app\app\templates\estilo.html chatbot_maxxag\wa-ops\kpi-app\app\templates\ajustes.html chatbot_maxxag\wa-ops\kpi-app\app\templates\conversation.html root@72.62.190.116:/opt/wa-ops/kpi-app/app/templates/

# script opcional (poblar candidatos ya, sin esperar al cron)
scp chatbot_maxxag\wa-ops\scripts\trigger_harvest.py root@72.62.190.116:/opt/wa-ops/scripts/
```

## 2) Build + migrar (en el VPS / Browser Terminal de Hostinger)

```bash
cd /opt/wa-ops && docker compose build kpi-app && docker compose up -d --force-recreate kpi-app kpi-worker && docker compose exec -T kpi-app alembic upgrade head
```

Debe terminar en `0020` (head). Si `alembic upgrade head` falla, NO pasa nada grave: el código nuevo es fail-soft (sin las tablas, simplemente no inyecta estilo ni marca conversión), pero arréglalo antes de usar las pantallas nuevas.

## 3) (Opcional) Poblar candidatos de estilo ahora mismo

```bash
cd /opt/wa-ops
docker compose cp scripts/trigger_harvest.py kpi-app:/tmp/trigger_harvest.py
docker compose exec -u root -T kpi-app python /tmp/trigger_harvest.py
```

Imprime cuántos candidatos por casa. Si no, el cron lo hace solo cada noche (~04:30 UTC).

## 4) Verificar

- [ ] Abre **Ajustes → Entrenamiento de Sara** (`/ajustes/estilo`): se ven candidatos pendientes por casa; **Aprobar/Rechazar** funciona.
- [ ] Abre una conversación: arriba a la derecha está **"Marcar reservado"**; al pulsar queda **"✓ Reservado"** (toggle).
- [ ] Escribe al bot en inglés/italiano (número en modo auto de pruebas) → responde en ese idioma.
- [ ] Tras aprobar 3-4 ejemplos de una casa, las respuestas de Sara suenan más a su encargada.
- [ ] El bloque "A/B de saludos" en Entrenamiento se llena a medida que hay conversaciones + reservas marcadas.

## Notas

- **Aprende de TODAS las respuestas humanas** (no solo de las que convirtieron) — por casa. Cuando tengas histórico de "reservado", podemos cambiar el harvest para que aprenda solo de las que cierran.
- **Revisa SIEMPRE antes de aprobar**: los candidatos están saneados (sin teléfonos/URLs) pero pueden llevar nombres; aprueba solo los que quieras que Sara imite.
- A/B: los 3 estilos son matices suaves del 1er mensaje, compatibles con las reglas (corto, una pregunta, sin presentarse).
