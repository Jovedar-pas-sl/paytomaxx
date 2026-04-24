"""
Analiza conversaciones con Claude AI y genera informes
"""

import anthropic
import json
from datetime import datetime
from pathlib import Path
from config import ANTHROPIC_API_KEY, CLAUDE_MODEL


def get_client():
    if not ANTHROPIC_API_KEY:
        raise ValueError("Falta ANTHROPIC_API_KEY en config.py")
    return anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)


SYSTEM_PROMPT = """Eres un asistente experto en análisis de conversaciones de soporte técnico y gestión de salas de juego/cajeros automáticos (ATMs/dispensadores de efectivo).

Tu tarea es analizar conversaciones de WhatsApp entre el servicio técnico y los locales/clientes, y generar un informe estructurado.

Tienes acceso a los manuales técnicos del dispensador F53 (Fujitsu) y piezas del cajero como referencia.

Para cada conversación, debes identificar:
1. **Quién es el cliente/local** y su contexto
2. **Problemas o incidencias** mencionados (técnicos, operativos, de dinero, de máquinas)
3. **Estado de resolución** (resuelto / pendiente / en proceso)
4. **Soluciones aplicadas o recomendadas**
5. **Próximos pasos o acciones pendientes**
6. **Nivel de urgencia** (Alto / Medio / Bajo)

Si mencionan problemas con el dispensador F53 o componentes del cajero, consulta los manuales para dar recomendaciones técnicas precisas.

Responde SIEMPRE en JSON con esta estructura exacta:
{
  "local": "nombre del local o cliente",
  "telefono": "número de teléfono",
  "periodo": "fecha inicio - fecha fin de la conversación",
  "resumen": "resumen en 2-3 frases",
  "problemas": [
    {
      "descripcion": "descripción del problema",
      "tipo": "técnico|operativo|financiero|otro",
      "estado": "resuelto|pendiente|en_proceso",
      "urgencia": "alto|medio|bajo",
      "solucion_aplicada": "qué se hizo",
      "recomendacion": "qué se recomienda si no está resuelto"
    }
  ],
  "acciones_pendientes": ["acción 1", "acción 2"],
  "notas_tecnicas": "notas relevantes del manual si aplica",
  "puntuacion_satisfaccion": "1-5 estimado",
  "ultima_actividad": "fecha último mensaje"
}"""


def analyze_single_conversation(conversation, manuals_summary="", client=None):
    """Analiza una conversación y devuelve el informe estructurado."""

    if client is None:
        client = get_client()

    name = conversation.get("name", "Desconocido")
    phone = conversation.get("remote_jid", "").replace("@s.whatsapp.net", "").replace("@lid", "")
    conv_text = conversation.get("conversation_text", "")
    msg_count = conversation.get("message_count", 0)

    if not conv_text.strip() or msg_count < 2:
        return None

    # Truncar conversación muy larga (máx 15k chars)
    if len(conv_text) > 15000:
        conv_text = conv_text[:7500] + "\n\n[... conversación truncada ...]\n\n" + conv_text[-7500:]

    user_message = f"""Analiza esta conversación de WhatsApp:

CONTACTO: {name}
TELÉFONO: {phone}
MENSAJES: {msg_count}

=== CONVERSACIÓN ===
{conv_text}
"""

    if manuals_summary:
        user_message += f"\n\n=== REFERENCIA TÉCNICA (Manuales) ===\n{manuals_summary[:5000]}"

    try:
        response = client.messages.create(
            model=CLAUDE_MODEL,
            max_tokens=2000,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_message}]
        )

        raw = response.content[0].text.strip()

        # Limpiar posibles markdown wrappers
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]
        if raw.endswith("```"):
            raw = raw[:-3]

        result = json.loads(raw.strip())
        result["_meta"] = {
            "analyzed_at": datetime.now().isoformat(),
            "remote_jid": conversation.get("remote_jid"),
            "message_count": msg_count
        }
        return result

    except json.JSONDecodeError as e:
        # Si no es JSON válido, devolver respuesta raw
        return {
            "local": name,
            "telefono": phone,
            "error": f"Respuesta no parseable: {str(e)}",
            "raw_response": raw[:500],
            "_meta": {"analyzed_at": datetime.now().isoformat()}
        }
    except Exception as e:
        print(f"  Error analizando {name}: {e}")
        return None


def analyze_all_conversations(conversations, manuals_summary="", save_progress=True):
    """
    Analiza todas las conversaciones.
    Guarda progreso por si se interrumpe.
    """
    client = get_client()
    results = []
    total = len(conversations)

    # Cargar progreso previo si existe
    progress_file = Path("reports") / "analysis_progress.json"
    analyzed_jids = set()
    if progress_file.exists() and save_progress:
        with open(progress_file, "r", encoding="utf-8") as f:
            prev = json.load(f)
            results = prev
            analyzed_jids = {r.get("_meta", {}).get("remote_jid") for r in results if r}

    print(f"\nAnalizando {total} conversaciones ({len(analyzed_jids)} ya procesadas)...")

    for i, conv in enumerate(conversations):
        jid = conv.get("remote_jid")

        if jid in analyzed_jids:
            print(f"  [{i+1}/{total}] {conv.get('name')} - ya analizado, saltando")
            continue

        name = conv.get("name", "Desconocido")
        print(f"  [{i+1}/{total}] Analizando: {name}...")

        result = analyze_single_conversation(conv, manuals_summary, client)

        if result:
            results.append(result)
            analyzed_jids.add(jid)

            # Guardar progreso
            if save_progress:
                progress_file.parent.mkdir(exist_ok=True)
                with open(progress_file, "w", encoding="utf-8") as f:
                    json.dump(results, f, ensure_ascii=False, indent=2)

    print(f"\nAnálisis completado: {len(results)} conversaciones procesadas")
    return results


if __name__ == "__main__":
    # Test rápido con una conversación de ejemplo
    test_conv = {
        "name": "Test Local",
        "remote_jid": "34600000000@s.whatsapp.net",
        "message_count": 5,
        "conversation_text": "[25/03/2026 10:00] CLIENTE: Buenos días, el cajero no dispensa billetes\n[25/03/2026 10:05] YO: Revisamos ahora mismo\n[25/03/2026 10:10] CLIENTE: Aparece error E101 en pantalla"
    }
    result = analyze_single_conversation(test_conv)
    print(json.dumps(result, ensure_ascii=False, indent=2))
