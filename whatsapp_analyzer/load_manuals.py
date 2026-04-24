"""
Carga y procesa los manuales PDF (F53 y piezas del cajero)
"""

import re
from pathlib import Path
from config import MANUALS_DIR


def extract_text_from_pdf(pdf_path):
    """Extrae texto de un PDF usando pdfminer."""
    try:
        from pdfminer.high_level import extract_text
        import logging
        logging.getLogger("pdfminer").setLevel(logging.ERROR)
        text = extract_text(str(pdf_path))
        # Limpiar artefactos CID (caracteres no mapeados)
        text = re.sub(r'\(cid:\d+\)', '', text)
        # Limpiar espacios excesivos
        text = re.sub(r'\n{3,}', '\n\n', text)
        text = re.sub(r'[ \t]+', ' ', text)
        return text.strip()
    except Exception as e:
        return f"[Error leyendo {pdf_path.name}: {e}]"


def load_all_manuals():
    """
    Carga todos los PDFs de la carpeta de manuales.
    Devuelve dict: {nombre_archivo: texto_extraido}
    """
    manuals_path = Path(MANUALS_DIR)

    if not manuals_path.exists():
        print(f"AVISO: Carpeta de manuales no encontrada: {MANUALS_DIR}")
        return {}

    manuals = {}
    # Usar un set para evitar duplicados entre glob y glob recursivo
    seen = set()
    pdf_files = []
    for p in list(manuals_path.glob("*.pdf")) + list(manuals_path.glob("**/*.pdf")):
        if p.resolve() not in seen:
            seen.add(p.resolve())
            pdf_files.append(p)

    print(f"Manuales encontrados: {len(pdf_files)}")

    for pdf_path in pdf_files:
        print(f"  Cargando: {pdf_path.name}")
        text = extract_text_from_pdf(pdf_path)
        manuals[pdf_path.name] = {
            "path": str(pdf_path),
            "name": pdf_path.name,
            "text": text[:50000],  # Máximo 50k chars por manual
            "size": len(text)
        }
        print(f"    → {len(text)} caracteres extraídos")

    return manuals


def get_manual_summary(manuals):
    """Genera un resumen de los manuales disponibles para el prompt."""
    if not manuals:
        return "No hay manuales disponibles."

    summary_parts = []
    for name, info in manuals.items():
        # Tomar primeros 3000 chars como extracto relevante
        extract = info["text"][:3000]
        summary_parts.append(f"=== MANUAL: {name} ===\n{extract}\n")

    return "\n".join(summary_parts)


if __name__ == "__main__":
    manuals = load_all_manuals()
    for name, info in manuals.items():
        print(f"\n{name}: {info['size']} chars")
        print(info["text"][:200])
