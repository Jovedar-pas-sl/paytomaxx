"""
Configuración del sistema de análisis WhatsApp
"""
import os
from pathlib import Path
from dotenv import load_dotenv

# Carga .env desde la raíz del proyecto
load_dotenv(Path(__file__).parent.parent / ".env")

# Evolution API
EVOLUTION_API_URL = "http://localhost:8080"
EVOLUTION_API_KEY = "evolution_secret_key"
EVOLUTION_INSTANCE = "chatwoot"

# Anthropic (Claude) — cargado desde .env
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
if not ANTHROPIC_API_KEY:
    raise RuntimeError("Falta ANTHROPIC_API_KEY en .env")

# Análisis
DAYS_BACK = 30          # Días hacia atrás para analizar
REFRESH_HOURS = 48      # Cada cuántas horas refrescar (48 o 72)

# Rutas
REPORTS_DIR = "reports"
MANUALS_DIR = r"C:\Users\mehdi\Desktop\F53 manuales"

# Modelo Claude a usar
CLAUDE_MODEL = "claude-sonnet-4-6"
