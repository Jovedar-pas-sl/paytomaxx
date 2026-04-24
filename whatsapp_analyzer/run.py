"""
Script principal - Ejecuta el análisis completo de conversaciones WhatsApp

Uso:
  py -3 run.py              → Análisis completo (último mes)
  py -3 run.py --refresh    → Solo conversaciones nuevas (últimas 48h)
  py -3 run.py --fetch-only → Solo descarga, sin analizar
  py -3 run.py --report-only → Solo genera informe con datos existentes
"""

import sys
import json
import os
import io
from pathlib import Path
from datetime import datetime

# Asegurarse de que el directorio actual sea el del script
os.chdir(Path(__file__).parent)

# Forzar UTF-8 en Windows
if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

from config import ANTHROPIC_API_KEY, DAYS_BACK, REFRESH_HOURS, REPORTS_DIR


def check_config():
    """Verifica que la configuración esté completa."""
    errors = []
    if not ANTHROPIC_API_KEY:
        errors.append("❌ ANTHROPIC_API_KEY no está configurada en config.py")
    if errors:
        print("\n".join(errors))
        print("\n→ Edita whatsapp_analyzer/config.py y añade tu API key de Anthropic")
        print("  https://console.anthropic.com/\n")
        return False
    return True


def run_full_analysis(days_back=None, refresh_mode=False):
    """Ejecuta el análisis completo."""
    from fetch_conversations import fetch_all_conversations, filter_recent_messages
    from load_manuals import load_all_manuals, get_manual_summary
    from analyze_conversations import analyze_all_conversations
    from generate_reports import generate_html_report, generate_markdown_summary

    if not check_config() and not "--fetch-only" in sys.argv:
        return

    print("=" * 60)
    print(f"  ANÁLISIS WHATSAPP - {datetime.now().strftime('%d/%m/%Y %H:%M')}")
    print("=" * 60)

    # 1. Cargar manuales
    print("\n📚 Cargando manuales técnicos...")
    manuals = load_all_manuals()
    manuals_summary = get_manual_summary(manuals)

    # 2. Descargar conversaciones
    actual_days = REFRESH_HOURS / 24 if refresh_mode else (days_back or DAYS_BACK)
    print(f"\n📥 Descargando conversaciones (últimos {actual_days:.0f} días)...")
    conversations = fetch_all_conversations(save_to_file=True)

    if "--fetch-only" in sys.argv:
        print("\n✅ Descarga completada. Usa --report-only para generar informe.")
        return

    if not conversations:
        print("❌ No se encontraron conversaciones en el período.")
        return

    # 3. Analizar con Claude
    print(f"\n🤖 Analizando {len(conversations)} conversaciones con Claude...")
    results = analyze_all_conversations(conversations, manuals_summary)

    # 4. Guardar resultados
    results_file = Path(REPORTS_DIR) / "analysis_results.json"
    results_file.parent.mkdir(exist_ok=True)
    with open(results_file, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)

    # 5. Generar informes
    print("\n📊 Generando informes...")
    timestamp = datetime.now().strftime("%Y%m%d_%H%M")
    html_path = generate_html_report(results, Path(REPORTS_DIR) / f"informe_{timestamp}.html")
    md_path = generate_markdown_summary(results, Path(REPORTS_DIR) / f"resumen_{timestamp}.md")

    # También guardar como "latest" para fácil acceso
    import shutil
    shutil.copy(html_path, Path(REPORTS_DIR) / "informe_latest.html")
    shutil.copy(md_path, Path(REPORTS_DIR) / "resumen_latest.md")

    print(f"\n{'='*60}")
    print("  ✅ ANÁLISIS COMPLETADO")
    print(f"{'='*60}")
    print(f"  📊 HTML:     reports/informe_latest.html")
    print(f"  📝 Markdown: reports/resumen_latest.md")
    print(f"  💾 Datos:    reports/analysis_results.json")
    print(f"{'='*60}")

    # Resumen rápido en consola
    urgentes = sum(1 for r in results for p in r.get("problemas", []) if p.get("urgencia") == "alto")
    pendientes = sum(1 for r in results for p in r.get("problemas", []) if p.get("estado") == "pendiente")
    print(f"\n  🔴 Urgentes: {urgentes}  ⏳ Pendientes: {pendientes}")

    return results


def run_report_only():
    """Genera informes usando datos ya analizados."""
    from generate_reports import generate_html_report, generate_markdown_summary

    results_file = Path(REPORTS_DIR) / "analysis_results.json"
    if not results_file.exists():
        print(f"❌ No hay datos previos en {results_file}")
        print("   Ejecuta primero: py -3 run.py")
        return

    with open(results_file, "r", encoding="utf-8") as f:
        results = json.load(f)

    print(f"Regenerando informes para {len(results)} conversaciones...")
    timestamp = datetime.now().strftime("%Y%m%d_%H%M")
    generate_html_report(results, Path(REPORTS_DIR) / f"informe_{timestamp}.html")
    generate_markdown_summary(results, Path(REPORTS_DIR) / f"resumen_{timestamp}.md")

    import shutil
    shutil.copy(Path(REPORTS_DIR) / f"informe_{timestamp}.html",
                Path(REPORTS_DIR) / "informe_latest.html")
    print("✅ Informes regenerados → reports/informe_latest.html")


if __name__ == "__main__":
    args = sys.argv[1:]

    if "--report-only" in args:
        run_report_only()
    elif "--refresh" in args:
        run_full_analysis(refresh_mode=True)
    else:
        run_full_analysis()
