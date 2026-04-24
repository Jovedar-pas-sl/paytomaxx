"""
peanpe_bot.py - Automatización de PeanPe Payments con Playwright

Flujo:
  1. Login con sesión persistente (no re-loguea en cada cobro)
  2. Crear cobro → devuelve URL del enlace de pago
  3. Verificar si el pago fue completado (polling desde el dashboard)
  4. Genera QR en base64 para mostrar en pantalla del cobrador
"""

import os
import json
import io
import base64
import time
from pathlib import Path
from dotenv import load_dotenv

ROOT        = Path(__file__).parent.parent
ENV_FILE    = ROOT / "pago_config.env"
SESSION_FILE = ROOT / "peanpe_session.json"
DEBUG_DIR   = ROOT / "peanpe_debug"
PEANPE_BASE = "https://www.peanpe.com"

load_dotenv(ENV_FILE)
PEANPE_EMAIL = os.getenv("PEANPE_EMAIL", "")
PEANPE_PASS  = os.getenv("PEANPE_PASS", "")


# ─────────────────────────────────────────────
# Utilidades internas
# ─────────────────────────────────────────────

def _screenshot(page, nombre: str):
    """Guarda captura de pantalla para depuración."""
    DEBUG_DIR.mkdir(exist_ok=True)
    ruta = DEBUG_DIR / f"{nombre}.png"
    page.screenshot(path=str(ruta), full_page=True)
    print(f"  📸 Screenshot: {ruta}")


def _get_browser_ctx(playwright):
    """Crea navegador con sesión guardada si existe."""
    browser = playwright.chromium.launch(
        headless=True,
        args=["--no-sandbox", "--disable-dev-shm-usage"]
    )
    kwargs = {"viewport": {"width": 430, "height": 932}}
    if SESSION_FILE.exists():
        try:
            kwargs["storage_state"] = str(SESSION_FILE)
        except Exception:
            pass
    ctx = browser.new_context(**kwargs)
    return browser, ctx


def _save_session(ctx):
    ctx.storage_state(path=str(SESSION_FILE))


def _esta_logueado(page) -> bool:
    url = page.url.lower()
    return not any(k in url for k in ("acceso", "login", "iniciar", "conectar"))


def _login(page):
    """Realiza el login en PeanPe."""
    print("  🔐 Iniciando sesión en PeanPe...")
    page.goto(f"{PEANPE_BASE}/acceso", wait_until="domcontentloaded")
    page.wait_for_timeout(1500)

    # Email: puede ser type=email o type=text
    email_sel = "input[type='email'], input[name='email'], input[name='usuario']"
    page.wait_for_selector(email_sel, timeout=8000)
    page.fill(email_sel, PEANPE_EMAIL)

    # Password: tiene id="pass"
    page.fill("#pass, input[type='password']", PEANPE_PASS)

    # Botón conectar
    page.click("button:has-text('Conectar'), input[type='submit'], button[type='submit']")
    page.wait_for_load_state("networkidle", timeout=12000)

    if not _esta_logueado(page):
        _screenshot(page, "login_fallo")
        raise RuntimeError(
            "Login fallido. Comprueba las credenciales en pago_config.env. "
            "Screenshot guardado en peanpe_debug/login_fallo.png"
        )
    print("  ✅ Sesión iniciada")


def _ir_panel(page):
    """Navega al panel/dashboard de PeanPe."""
    for url in [f"{PEANPE_BASE}/panel", f"{PEANPE_BASE}/v2", f"{PEANPE_BASE}/dashboard"]:
        page.goto(url, wait_until="domcontentloaded")
        page.wait_for_timeout(1000)
        if _esta_logueado(page):
            return
    # Si redirigió a login, volver a loguear
    if not _esta_logueado(page):
        _login(page)


# ─────────────────────────────────────────────
# Función principal: crear cobro
# ─────────────────────────────────────────────

def crear_cobro(importe: float) -> dict:
    """
    Automatiza PeanPe para generar un enlace de cobro.

    Args:
        importe: Cantidad a cobrar en euros (ej: 15.50)

    Returns:
        {
            "ok": bool,
            "url": str,       # enlace de pago para el cliente
            "codigo": str,    # código del pago
            "error": str      # mensaje de error si ok=False
        }
    """
    if not PEANPE_EMAIL or not PEANPE_PASS:
        return {
            "ok": False,
            "error": "Faltan credenciales. Rellena PEANPE_EMAIL y PEANPE_PASS en pago_config.env"
        }

    from playwright.sync_api import sync_playwright

    try:
        with sync_playwright() as p:
            browser, ctx = _get_browser_ctx(p)
            page = ctx.new_page()

            # ── 1. Ir al panel ───────────────────────────
            _ir_panel(page)
            if not _esta_logueado(page):
                _login(page)
                _save_session(ctx)
                _ir_panel(page)

            _screenshot(page, "panel_inicio")

            # ── 2. Buscar el botón "Cobrar" / "Nuevo cobro" ─
            print("  🔍 Buscando botón de cobro...")
            cobrar_sel = (
                "a:has-text('Cobrar'), a:has-text('Nuevo cobro'), a:has-text('Crear cobro'), "
                "button:has-text('Cobrar'), button:has-text('Nuevo cobro'), "
                "a[href*='cobro'], a[href*='pago'], a[href*='charge']"
            )
            try:
                page.wait_for_selector(cobrar_sel, timeout=6000)
                page.click(cobrar_sel)
                page.wait_for_load_state("networkidle", timeout=10000)
            except Exception:
                _screenshot(page, "panel_sin_boton_cobro")
                browser.close()
                return {
                    "ok": False,
                    "error": (
                        "No se encontró el botón 'Cobrar' en el panel. "
                        "Revisa peanpe_debug/panel_inicio.png y peanpe_debug/panel_sin_boton_cobro.png "
                        "para identificar el selector correcto."
                    )
                }

            _screenshot(page, "formulario_cobro")

            # ── 3. Rellenar el importe ───────────────────
            print(f"  💶 Rellenando importe: {importe:.2f} €")
            importe_str = f"{importe:.2f}"

            importe_sel = (
                "input[name='importe'], input[name='amount'], input[name='precio'], "
                "input[name='cantidad'], input[placeholder*='importe'], "
                "input[placeholder*='precio'], input[placeholder*='amount'], "
                "input[type='number'], input[inputmode='decimal']"
            )
            try:
                page.wait_for_selector(importe_sel, timeout=5000)
                page.fill(importe_sel, importe_str)
            except Exception:
                # Fallback: primer input numérico visible
                inputs = page.locator("input:visible").all()
                for inp in inputs:
                    tipo = inp.get_attribute("type") or ""
                    if tipo in ("number", "text", "decimal", ""):
                        inp.fill(importe_str)
                        break

            # ── 4. Confirmar / generar enlace ────────────
            gen_sel = (
                "button:has-text('Generar'), button:has-text('Cobrar'), "
                "button:has-text('Crear'), button:has-text('Continuar'), "
                "button[type='submit'], input[type='submit']"
            )
            try:
                page.click(gen_sel)
            except Exception:
                page.keyboard.press("Enter")

            page.wait_for_load_state("networkidle", timeout=15000)
            page.wait_for_timeout(2000)
            _screenshot(page, "pago_generado")

            # ── 5. Extraer la URL del pago ───────────────
            print("  🔗 Extrayendo enlace de pago...")
            payment_url = None

            # Opción A: input con la URL completa
            for sel in [
                f"input[value*='{PEANPE_BASE}/pago']",
                "input[value*='peanpe.com/pago']",
                "input[readonly][value*='http']",
                "input[value*='http']",
            ]:
                el = page.locator(sel).first
                if el.count() > 0:
                    payment_url = el.get_attribute("value")
                    break

            # Opción B: <a> con el enlace
            if not payment_url:
                for sel in ["a[href*='/pago/']", "a[href*='peanpe.com/pago']"]:
                    el = page.locator(sel).first
                    if el.count() > 0:
                        href = el.get_attribute("href")
                        if href:
                            payment_url = href if href.startswith("http") else PEANPE_BASE + href
                        break

            # Opción C: la URL actual ya ES el pago
            if not payment_url and "/pago/" in page.url:
                payment_url = page.url

            # Opción D: buscar en el texto de la página
            if not payment_url:
                contenido = page.content()
                import re
                match = re.search(r'https?://(?:www\.)?peanpe\.com/pago/[\w\-]+', contenido)
                if match:
                    payment_url = match.group()

            _save_session(ctx)
            browser.close()

            if payment_url:
                codigo = payment_url.rstrip("/").split("/")[-1]
                print(f"  ✅ Cobro creado: {payment_url}")
                return {"ok": True, "url": payment_url, "codigo": codigo}
            else:
                return {
                    "ok": False,
                    "error": (
                        "Cobro creado pero no se encontró el enlace. "
                        "Revisa peanpe_debug/pago_generado.png"
                    )
                }

    except RuntimeError as e:
        return {"ok": False, "error": str(e)}
    except Exception as e:
        return {"ok": False, "error": f"Error inesperado: {e}"}


# ─────────────────────────────────────────────
# Verificar estado del pago
# ─────────────────────────────────────────────

PALABRAS_PAGADO   = {"pagado", "completado", "cobrado", "aprobado", "paid", "approved", "success"}
PALABRAS_PENDIENTE = {"pendiente", "esperando", "pending", "waiting"}


def verificar_pago(codigo: str) -> dict:
    """
    Verifica en el dashboard de PeanPe si un cobro fue completado.

    Args:
        codigo: Código del pago (parte final de la URL)

    Returns:
        {"pagado": bool, "estado": str}
    """
    from playwright.sync_api import sync_playwright

    try:
        with sync_playwright() as p:
            browser, ctx = _get_browser_ctx(p)
            page = ctx.new_page()

            _ir_panel(page)
            if not _esta_logueado(page):
                _login(page)

            # Intentar URL directa del cobro en el panel
            for url_patron in [
                f"{PEANPE_BASE}/panel/cobro/{codigo}",
                f"{PEANPE_BASE}/panel/pago/{codigo}",
                f"{PEANPE_BASE}/panel/cobros",
                f"{PEANPE_BASE}/panel/historial",
            ]:
                page.goto(url_patron, wait_until="domcontentloaded")
                page.wait_for_timeout(1000)
                contenido = page.inner_text("body").lower()
                if codigo.lower() in contenido or any(w in contenido for w in PALABRAS_PAGADO):
                    break

            contenido = page.inner_text("body").lower()
            browser.close()

            if any(w in contenido for w in PALABRAS_PAGADO):
                return {"pagado": True, "estado": "pagado"}
            elif any(w in contenido for w in PALABRAS_PENDIENTE):
                return {"pagado": False, "estado": "pendiente"}
            else:
                return {"pagado": False, "estado": "pendiente"}

    except Exception as e:
        return {"pagado": False, "estado": "error", "error": str(e)}


# ─────────────────────────────────────────────
# Generar QR en base64
# ─────────────────────────────────────────────

def url_a_qr_base64(url: str) -> str:
    """Convierte una URL en imagen QR codificada en base64."""
    import qrcode
    qr = qrcode.QRCode(
        version=1,
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        box_size=12,
        border=3,
    )
    qr.add_data(url)
    qr.make(fit=True)
    img = qr.make_image(fill_color="#111827", back_color="white")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


# ─────────────────────────────────────────────
# Test rápido (ejecutar directamente)
# ─────────────────────────────────────────────

if __name__ == "__main__":
    print("=== Test peanpe_bot.py ===")
    resultado = crear_cobro(1.00)
    print(json.dumps(resultado, indent=2, ensure_ascii=False))
