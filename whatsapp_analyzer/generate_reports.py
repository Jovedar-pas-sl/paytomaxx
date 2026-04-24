"""
Genera informes HTML y Markdown a partir del análisis
"""

import json
from datetime import datetime
from pathlib import Path


URGENCIA_COLOR = {"alto": "#e74c3c", "medio": "#f39c12", "bajo": "#27ae60"}
ESTADO_EMOJI = {"resuelto": "✅", "pendiente": "⏳", "en_proceso": "🔄"}


def generate_html_report(results, output_path=None):
    """Genera un informe HTML completo."""

    if output_path is None:
        output_path = Path("reports") / f"informe_{datetime.now().strftime('%Y%m%d_%H%M')}.html"

    output_path = Path(output_path)
    output_path.parent.mkdir(exist_ok=True)

    # Estadísticas globales
    total = len(results)
    problemas_totales = sum(len(r.get("problemas", [])) for r in results)
    pendientes = sum(
        1 for r in results
        for p in r.get("problemas", [])
        if p.get("estado") == "pendiente"
    )
    urgentes = sum(
        1 for r in results
        for p in r.get("problemas", [])
        if p.get("urgencia") == "alto"
    )

    fecha_informe = datetime.now().strftime("%d/%m/%Y %H:%M")

    html = f"""<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Informe WhatsApp - {fecha_informe}</title>
<style>
  body {{ font-family: 'Segoe UI', sans-serif; margin: 0; background: #f5f5f5; color: #333; }}
  .header {{ background: #075E54; color: white; padding: 20px 40px; }}
  .header h1 {{ margin: 0; font-size: 24px; }}
  .header p {{ margin: 5px 0 0; opacity: 0.8; }}
  .stats {{ display: flex; gap: 20px; padding: 20px 40px; background: white; border-bottom: 1px solid #ddd; flex-wrap: wrap; }}
  .stat {{ text-align: center; padding: 10px 20px; border-radius: 8px; min-width: 100px; }}
  .stat .num {{ font-size: 32px; font-weight: bold; }}
  .stat .lbl {{ font-size: 12px; color: #666; text-transform: uppercase; }}
  .stat.blue {{ background: #e3f2fd; color: #1565c0; }}
  .stat.red {{ background: #ffebee; color: #c62828; }}
  .stat.orange {{ background: #fff3e0; color: #e65100; }}
  .stat.green {{ background: #e8f5e9; color: #2e7d32; }}
  .container {{ padding: 20px 40px; max-width: 1200px; margin: 0 auto; }}
  .chat-card {{ background: white; border-radius: 12px; margin-bottom: 20px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); overflow: hidden; }}
  .chat-header {{ background: #075E54; color: white; padding: 15px 20px; display: flex; justify-content: space-between; align-items: center; }}
  .chat-header h2 {{ margin: 0; font-size: 18px; }}
  .chat-meta {{ font-size: 13px; opacity: 0.8; }}
  .chat-body {{ padding: 20px; }}
  .resumen {{ background: #f8f9fa; padding: 12px; border-radius: 8px; margin-bottom: 15px; font-style: italic; border-left: 4px solid #075E54; }}
  .problemas-title {{ font-weight: bold; margin-bottom: 10px; color: #075E54; }}
  .problema {{ border: 1px solid #e0e0e0; border-radius: 8px; padding: 12px; margin-bottom: 10px; }}
  .problema-header {{ display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }}
  .badge {{ padding: 3px 10px; border-radius: 20px; font-size: 12px; font-weight: bold; color: white; }}
  .problema-desc {{ font-size: 15px; margin-bottom: 6px; }}
  .problema-detail {{ font-size: 13px; color: #555; margin: 4px 0; }}
  .pendientes {{ background: #fff3cd; border: 1px solid #ffc107; border-radius: 8px; padding: 12px; margin-top: 15px; }}
  .pendientes-title {{ font-weight: bold; color: #856404; margin-bottom: 8px; }}
  .pendientes ul {{ margin: 0; padding-left: 20px; }}
  .pendientes li {{ margin: 4px 0; font-size: 14px; }}
  .notas {{ background: #e8f5e9; border-radius: 8px; padding: 12px; margin-top: 10px; font-size: 13px; }}
  .filter-bar {{ padding: 15px 40px; background: white; border-bottom: 1px solid #ddd; display: flex; gap: 10px; flex-wrap: wrap; }}
  .filter-btn {{ padding: 6px 16px; border: 2px solid #075E54; border-radius: 20px; background: white; color: #075E54; cursor: pointer; font-size: 13px; transition: all 0.2s; }}
  .filter-btn.active {{ background: #075E54; color: white; }}
  input#search {{ padding: 6px 14px; border: 2px solid #ddd; border-radius: 20px; font-size: 13px; width: 220px; outline: none; }}
  input#search:focus {{ border-color: #075E54; }}
  .no-problems {{ color: #999; font-style: italic; padding: 10px 0; }}
  @media print {{ .filter-bar {{ display: none; }} }}
</style>
</head>
<body>

<div class="header">
  <h1>📱 Informe de Conversaciones WhatsApp</h1>
  <p>Generado el {fecha_informe} · Período: últimos 30 días</p>
</div>

<div class="stats">
  <div class="stat blue"><div class="num">{total}</div><div class="lbl">Conversaciones</div></div>
  <div class="stat orange"><div class="num">{problemas_totales}</div><div class="lbl">Problemas detectados</div></div>
  <div class="stat red"><div class="num">{urgentes}</div><div class="lbl">Urgentes</div></div>
  <div class="stat green"><div class="num">{pendientes}</div><div class="lbl">Pendientes</div></div>
</div>

<div class="filter-bar">
  <button class="filter-btn active" onclick="filterCards(this,'all')">Todos</button>
  <button class="filter-btn" onclick="filterCards(this,'urgente')">🔴 Urgentes</button>
  <button class="filter-btn" onclick="filterCards(this,'pendiente')">⏳ Pendientes</button>
  <button class="filter-btn" onclick="filterCards(this,'resuelto')">✅ Resueltos</button>
  <input id="search" type="text" placeholder="🔍 Buscar local..." oninput="searchCards(this.value)">
  <span style="margin-left:auto;color:#666;font-size:13px;align-self:center">Mostrando <strong id="visible-count">{total}</strong> locales</span>
</div>

<div class="container" id="cards-container">
"""

    # Ordenar por urgencia
    def urgencia_score(r):
        probs = r.get("problemas", [])
        if any(p.get("urgencia") == "alto" for p in probs):
            return 0
        if any(p.get("urgencia") == "medio" for p in probs):
            return 1
        if any(p.get("estado") == "pendiente" for p in probs):
            return 2
        return 3

    sorted_results = sorted(results, key=urgencia_score)

    for result in sorted_results:
        if "error" in result and "problemas" not in result:
            continue

        local = result.get("local", "Desconocido")
        telefono = result.get("telefono", "")
        periodo = result.get("periodo", "")
        resumen = result.get("resumen", "")
        problemas = result.get("problemas", [])
        acciones = result.get("acciones_pendientes", [])
        notas = result.get("notas_tecnicas", "")
        ultima = result.get("ultima_actividad", "")
        msgs = result.get("_meta", {}).get("message_count", 0)

        # Determinar clase para filtro
        card_classes = ["chat-card"]
        has_urgente = any(p.get("urgencia") == "alto" for p in problemas)
        has_pendiente = any(p.get("estado") == "pendiente" for p in problemas)
        has_resuelto = any(p.get("estado") == "resuelto" for p in problemas)
        if has_urgente:
            card_classes.append("has-urgente")
        if has_pendiente:
            card_classes.append("has-pendiente")
        if has_resuelto:
            card_classes.append("has-resuelto")

        html += f"""
<div class="{' '.join(card_classes)}">
  <div class="chat-header">
    <div>
      <h2>📍 {local}</h2>
      <div class="chat-meta">📞 {telefono} · {msgs} mensajes · {ultima}</div>
    </div>
    <div class="chat-meta">{periodo}</div>
  </div>
  <div class="chat-body">
    <div class="resumen">💬 {resumen}</div>
"""

        if problemas:
            html += '<div class="problemas-title">🔍 Problemas detectados:</div>'
            for prob in problemas:
                desc = prob.get("descripcion", "")
                tipo = prob.get("tipo", "")
                estado = prob.get("estado", "")
                urgencia = prob.get("urgencia", "bajo")
                sol = prob.get("solucion_aplicada", "")
                rec = prob.get("recomendacion", "")

                color = URGENCIA_COLOR.get(urgencia, "#95a5a6")
                estado_icon = ESTADO_EMOJI.get(estado, "❓")

                # data attributes para filtrado granular
                html += f"""
    <div class="problema" data-urgencia="{urgencia}" data-estado="{estado}">
      <div class="problema-header">
        <span class="problema-desc"><strong>{desc}</strong></span>
        <div>
          <span class="badge" style="background:{color}">{urgencia.upper()}</span>
          &nbsp;<span>{estado_icon} {estado}</span>
        </div>
      </div>
      <div class="problema-detail">🏷️ Tipo: {tipo}</div>
"""
                if sol:
                    html += f'      <div class="problema-detail">✅ Solución: {sol}</div>\n'
                if rec:
                    html += f'      <div class="problema-detail">💡 Recomendación: {rec}</div>\n'
                html += "    </div>\n"
        else:
            html += '<div class="no-problems">Sin problemas detectados en este período</div>'

        if acciones:
            html += '<div class="pendientes"><div class="pendientes-title">📋 Acciones pendientes:</div><ul>'
            for accion in acciones:
                html += f"<li>{accion}</li>"
            html += "</ul></div>"

        if notas:
            html += f'<div class="notas">📚 <strong>Notas técnicas:</strong> {notas}</div>'

        html += "  </div>\n</div>\n"

    html += """
</div>

<script>
var currentFilter = 'all';

function filterCards(btn, type) {
  currentFilter = type;
  document.querySelectorAll('.filter-btn').forEach(function(b) { b.classList.remove('active'); });
  btn.classList.add('active');
  applyFilters();
}

function searchCards(val) {
  applyFilters();
}

function applyFilters() {
  var query = document.getElementById('search').value.toLowerCase().trim();

  document.querySelectorAll('.chat-card').forEach(function(card) {
    var searchMatch = !query || card.querySelector('.chat-header').innerText.toLowerCase().includes(query);

    if (!searchMatch) {
      card.style.display = 'none';
      return;
    }

    // Filtrar problemas individuales dentro de la card
    var problemas = card.querySelectorAll('.problema');
    var visibleCount = 0;

    problemas.forEach(function(p) {
      var show = true;
      if (currentFilter === 'urgente') {
        show = p.dataset.urgencia === 'alto';
      } else if (currentFilter === 'pendiente') {
        show = p.dataset.estado === 'pendiente';
      } else if (currentFilter === 'resuelto') {
        show = p.dataset.estado === 'resuelto';
      }
      p.style.display = show ? '' : 'none';
      if (show) visibleCount++;
    });

    // Si no hay problemas visibles y hay filtro activo, ocultar la card entera
    if (currentFilter !== 'all' && problemas.length > 0 && visibleCount === 0) {
      card.style.display = 'none';
    } else {
      card.style.display = '';
    }
  });

  // Actualizar contador visible
  var visible = document.querySelectorAll('.chat-card[style=""], .chat-card:not([style])').length;
  var counter = document.getElementById('visible-count');
  if (counter) counter.textContent = visible;
}
</script>
</body>
</html>"""

    with open(output_path, "w", encoding="utf-8") as f:
        f.write(html)

    print(f"Informe HTML guardado: {output_path}")
    return output_path


def generate_markdown_summary(results, output_path=None):
    """Genera un resumen en Markdown."""

    if output_path is None:
        output_path = Path("reports") / f"resumen_{datetime.now().strftime('%Y%m%d_%H%M')}.md"

    lines = [
        f"# Informe WhatsApp - {datetime.now().strftime('%d/%m/%Y %H:%M')}",
        "",
        f"**Total conversaciones:** {len(results)}",
        ""
    ]

    # Urgentes primero
    urgentes = [r for r in results if any(p.get("urgencia") == "alto" for p in r.get("problemas", []))]
    if urgentes:
        lines.append("## 🔴 URGENTES")
        for r in urgentes:
            lines.append(f"\n### {r.get('local', 'Desconocido')} ({r.get('telefono', '')})")
            for p in r.get("problemas", []):
                if p.get("urgencia") == "alto":
                    lines.append(f"- **{p['descripcion']}** → {p.get('estado', '')}")
        lines.append("")

    # Pendientes
    lines.append("## ⏳ PENDIENTES")
    for r in results:
        pendientes = [p for p in r.get("problemas", []) if p.get("estado") == "pendiente"]
        if pendientes:
            lines.append(f"\n### {r.get('local', 'Desconocido')}")
            for p in pendientes:
                lines.append(f"- {p['descripcion']}")
                if p.get("recomendacion"):
                    lines.append(f"  - 💡 {p['recomendacion']}")

    lines.append("\n---\n")
    lines.append("## Todos los locales")

    for r in results:
        local = r.get("local", "Desconocido")
        resumen = r.get("resumen", "")
        ultima = r.get("ultima_actividad", "")
        lines.append(f"\n### {local}")
        lines.append(f"*{resumen}* | Última actividad: {ultima}")

    with open(output_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

    print(f"Resumen Markdown guardado: {output_path}")
    return output_path


if __name__ == "__main__":
    # Test con datos de ejemplo
    test_data = [
        {
            "local": "Sala Maxx",
            "telefono": "34612345678",
            "periodo": "01/03/2026 - 26/03/2026",
            "resumen": "Problemas con el dispensador F53 y pendiente de reposición de efectivo",
            "problemas": [
                {
                    "descripcion": "Dispensador F53 no entrega billetes, error E101",
                    "tipo": "técnico",
                    "estado": "pendiente",
                    "urgencia": "alto",
                    "solucion_aplicada": "",
                    "recomendacion": "Revisar cassette de billetes y sensor de detección"
                }
            ],
            "acciones_pendientes": ["Enviar técnico mañana", "Reponer 20.000€"],
            "notas_tecnicas": "Error E101 indica problema en el módulo de transporte",
            "puntuacion_satisfaccion": "3",
            "ultima_actividad": "26/03/2026",
            "_meta": {"analyzed_at": "2026-03-26T12:00:00", "message_count": 45}
        }
    ]
    generate_html_report(test_data, "reports/test_report.html")
    generate_markdown_summary(test_data, "reports/test_summary.md")
