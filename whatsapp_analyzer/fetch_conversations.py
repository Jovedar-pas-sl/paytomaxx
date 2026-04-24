"""
Descarga conversaciones de Evolution API (último mes)
"""

import requests
import json
import time
import sys
from datetime import datetime, timedelta
from pathlib import Path
from config import EVOLUTION_API_URL, EVOLUTION_API_KEY, EVOLUTION_INSTANCE, DAYS_BACK


HEADERS = {
    "apikey": EVOLUTION_API_KEY,
    "Content-Type": "application/json"
}

def get_all_chats():
    """Obtiene todos los chats de la instancia."""
    url = f"{EVOLUTION_API_URL}/chat/findChats/{EVOLUTION_INSTANCE}"
    resp = requests.post(url, headers=HEADERS, json={})
    resp.raise_for_status()
    return resp.json()


def get_messages_for_chat(remote_jid, limit=500):
    """Obtiene mensajes de un chat específico."""
    url = f"{EVOLUTION_API_URL}/chat/findMessages/{EVOLUTION_INSTANCE}"
    payload = {
        "where": {
            "key": {"remoteJid": remote_jid}
        },
        "limit": limit
    }
    try:
        resp = requests.post(url, headers=HEADERS, json=payload, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        return data.get("messages", {}).get("records", [])
    except Exception as e:
        print(f"  Error fetching {remote_jid}: {e}")
        return []


def filter_recent_messages(messages, days_back=DAYS_BACK):
    """Filtra mensajes de los últimos N días."""
    cutoff = datetime.now() - timedelta(days=days_back)
    cutoff_ts = cutoff.timestamp()
    return [m for m in messages if m.get("messageTimestamp", 0) >= cutoff_ts]


def extract_text(message):
    """Extrae el texto de un mensaje (distintos tipos)."""
    msg = message.get("message", {})
    if not msg:
        return ""

    # Texto simple
    if "conversation" in msg:
        return msg["conversation"]

    # Texto extendido
    if "extendedTextMessage" in msg:
        return msg["extendedTextMessage"].get("text", "")

    # Imagen con caption
    if "imageMessage" in msg:
        return f"[IMAGEN] {msg['imageMessage'].get('caption', '')}"

    # Documento
    if "documentMessage" in msg:
        return f"[DOCUMENTO: {msg['documentMessage'].get('fileName', 'archivo')}]"

    # Audio
    if "audioMessage" in msg:
        return "[AUDIO]"

    # Video
    if "videoMessage" in msg:
        return f"[VIDEO] {msg['videoMessage'].get('caption', '')}"

    return f"[{message.get('messageType', 'desconocido')}]"


def build_conversation_text(messages):
    """Construye texto legible de la conversación."""
    lines = []
    for msg in sorted(messages, key=lambda x: x.get("messageTimestamp", 0)):
        ts = msg.get("messageTimestamp", 0)
        fecha = datetime.fromtimestamp(ts).strftime("%d/%m/%Y %H:%M")

        from_me = msg.get("key", {}).get("fromMe", False)
        quien = "YO" if from_me else msg.get("pushName", "CLIENTE")

        texto = extract_text(msg)
        if texto.strip():
            lines.append(f"[{fecha}] {quien}: {texto}")

    return "\n".join(lines)


def fetch_all_conversations(save_to_file=True):
    """
    Descarga todas las conversaciones del último mes.
    Devuelve lista de dicts con info de cada chat.
    """
    print(f"Obteniendo chats de los últimos {DAYS_BACK} días...")

    all_chats = get_all_chats()
    print(f"Total chats en instancia: {len(all_chats)}")
    sys.stdout.reconfigure(errors="replace")

    conversations = []
    cutoff = datetime.now() - timedelta(days=DAYS_BACK)

    active_chats = []
    for chat in all_chats:
        updated = chat.get("updatedAt", "")
        if updated:
            try:
                # Parsear fecha ISO
                updated_dt = datetime.fromisoformat(updated.replace("Z", "+00:00"))
                if updated_dt.replace(tzinfo=None) >= cutoff:
                    active_chats.append(chat)
            except Exception:
                active_chats.append(chat)

    print(f"Chats activos en el período: {len(active_chats)}")

    for i, chat in enumerate(active_chats):
        remote_jid = chat.get("remoteJid", "")
        name = chat.get("pushName", "") or remote_jid

        safe_name = name.encode("ascii", errors="replace").decode("ascii")
        print(f"  [{i+1}/{len(active_chats)}] {safe_name} ({remote_jid})")

        messages = get_messages_for_chat(remote_jid)
        recent = filter_recent_messages(messages)

        if not recent:
            continue

        conv_text = build_conversation_text(recent)

        conversations.append({
            "remote_jid": remote_jid,
            "name": name,
            "profile_pic": chat.get("profilePicUrl", ""),
            "updated_at": chat.get("updatedAt", ""),
            "message_count": len(recent),
            "conversation_text": conv_text,
            "raw_messages": recent
        })

        time.sleep(0.2)  # Pequeña pausa para no saturar la API

    print(f"\nConversaciones con mensajes recientes: {len(conversations)}")

    if save_to_file:
        output = Path("reports") / "conversations_raw.json"
        output.parent.mkdir(exist_ok=True)
        with open(output, "w", encoding="utf-8") as f:
            # Guardamos sin raw_messages para no saturar el archivo
            to_save = [{k: v for k, v in c.items() if k != "raw_messages"}
                      for c in conversations]
            json.dump(to_save, f, ensure_ascii=False, indent=2)
        print(f"Conversaciones guardadas en {output}")

    return conversations


if __name__ == "__main__":
    convs = fetch_all_conversations()
    for c in convs[:3]:
        print(f"\n--- {c['name']} ({c['message_count']} mensajes) ---")
        print(c["conversation_text"][:500])
