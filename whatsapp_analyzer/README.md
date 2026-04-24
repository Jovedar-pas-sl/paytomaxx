# WhatsApp Analyzer - Sistema de análisis de conversaciones

## Setup (una sola vez)

### 1. Añade tu API key de Anthropic en `config.py`
```python
ANTHROPIC_API_KEY = "sk-ant-..."  # https://console.anthropic.com/
```

### 2. Instalar dependencias (ya instalado)
```bash
pip install anthropic requests
```

---

## Uso

### Análisis completo (último mes)
```bash
cd whatsapp_analyzer
py -3 run.py
```

### Refresh rápido (últimas 48h)
```bash
py -3 run.py --refresh
```

### Solo descargar sin analizar
```bash
py -3 run.py --fetch-only
```

### Regenerar informe sin re-analizar
```bash
py -3 run.py --report-only
```

---

## Archivos generados

| Archivo | Descripción |
|---------|-------------|
| `reports/informe_latest.html` | Informe visual, ábrelo en el navegador |
| `reports/resumen_latest.md` | Resumen rápido en texto |
| `reports/analysis_results.json` | Datos completos del análisis |
| `reports/conversations_raw.json` | Conversaciones descargadas |

---

## Programar análisis automático cada 48h (Windows)

Abre el Programador de tareas de Windows y crea una tarea que ejecute:
```
py -3 -X utf8 C:\Users\mehdi\Documents\GitHub\first_tries\whatsapp_analyzer\run.py --refresh
```

O usa PowerShell:
```powershell
$action = New-ScheduledTaskAction -Execute "py" -Argument "-3 -X utf8 C:\Users\mehdi\Documents\GitHub\first_tries\whatsapp_analyzer\run.py --refresh"
$trigger = New-ScheduledTaskTrigger -RepetitionInterval (New-TimeSpan -Hours 48) -Once -At (Get-Date)
Register-ScheduledTask -TaskName "WhatsApp Analyzer" -Action $action -Trigger $trigger
```

---

## Manuales disponibles

Los PDFs en `C:\Users\mehdi\Desktop\F53 manuales` se cargan automáticamente:
- `Maintenance_Manual-Fujitsu.pdf`
- `Mnl_Emulator_F5x.pdf`
- `Operators_Guide.pdf`

Para añadir más manuales: copia el PDF en esa carpeta, se incluirá automáticamente.

---

## Estructura

```
whatsapp_analyzer/
├── config.py              ← Configuración (API keys, URLs)
├── run.py                 ← Script principal
├── fetch_conversations.py ← Descarga de Evolution API
├── load_manuals.py        ← Lectura de PDFs
├── analyze_conversations.py ← Análisis con Claude
├── generate_reports.py    ← Generación de HTML/MD
└── reports/               ← Informes generados
```
