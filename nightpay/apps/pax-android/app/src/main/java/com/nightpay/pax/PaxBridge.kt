package com.nightpay.pax

import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONException
import org.json.JSONObject
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Puente entre la pantalla web /pax y el lector (window.NightPayPax).
 *
 *   web → app:  NightPayPax.<método>(JSON con requestId y datos)
 *   app → web:  window.nightpayPaxCallback(requestId, JSON de respuesta)
 *
 * Respuesta: { ok: true, result?, transactions? } | { ok: false, error, message }.
 * Mismo contrato que apps/operator/src/lib/pax-bridge.ts.
 *
 * Cobrar del saldo (LocalReaders): capabilities, scanQr (cámara), readNfc
 * (ficha NFC) y cancelRead. Recepción y «Preparar fichas»: writeNfc (graba el
 * enlace de la ficha, solo si está en blanco y solo enlaces de fichas de la
 * propia pantalla). La cámara y el NFC van "de uno en uno" con los cobros: el
 * lector sin contacto es el mismo aparato.
 */
class PaxBridge(
    private val webView: WebView,
    private val paytef: PaytefClient,
    private val readers: LocalReaders,
    /** Fijar la app en pantalla (true) o soltarla (false). Lo hace MainActivity. */
    private val setLocked: (Boolean) -> Unit,
) {

    // Hilos aparte: "cancelar" no puede esperar a que acabe la venta en curso.
    private val executor: ExecutorService = Executors.newCachedThreadPool()
    private val main = Handler(Looper.getMainLooper())

    /** Una operación de cobro o anulación a la vez en el lector. */
    private val busy = AtomicBoolean(false)

    @Volatile
    private var closed = false

    /** Solo responde si la página cargada es la de NightPay (lo fija MainActivity). */
    @Volatile
    var trusted = false

    @JavascriptInterface
    fun startSale(json: String) = runExclusive(json) { req ->
        paytef.sale(req.getInt("amountCents"), req.getString("reference"))
    }

    @JavascriptInterface
    fun voidSale(json: String) = runExclusive(json) { req ->
        paytef.void(req.getString("operationNumber"), req.optInt("amountCents"), req.optString("reference"))
    }

    @JavascriptInterface
    fun cancel(json: String) = run(json) { paytef.cancel() }

    @JavascriptInterface
    fun lastResult(json: String) = run(json) { paytef.lastResult() }

    @JavascriptInterface
    fun shiftList(json: String) = run(json) { paytef.shiftList() }

    /** ¿Hay NFC de Android (listo, apagado, no disponible) y cámara? */
    @JavascriptInterface
    fun capabilities(json: String) = run(json) { readers.capabilities() }

    /** Cámara: el texto del QR (el del cobro de la chica o el del saldo del cliente). */
    @JavascriptInterface
    fun scanQr(json: String) = runExclusive(json) { req -> readers.scanQr(timeoutOf(req, SCAN_TIMEOUT_MS)) }

    /** Ficha NFC: { uid, url } (número de serie y el enlace grabado). */
    @JavascriptInterface
    fun readNfc(json: String) = runExclusive(json) { req -> readers.readNfc(timeoutOf(req, NFC_TIMEOUT_MS)) }

    /**
     * Ficha NFC en blanco: graba { url } y devuelve { uid, url, written }.
     * Solo enlaces de ficha de la pantalla de OxioPay (…/?ficha=<código>): una
     * página que no es la nuestra no graba nada (trusted) y la nuestra no
     * puede grabar otra cosa.
     */
    @JavascriptInterface
    fun writeNfc(json: String) = runExclusive(json) { req ->
        val url = req.getString("url")
        if (!isFichaUrl(url)) {
            failure("badRequest", "Ese enlace no es de una ficha de OxioPay")
        } else {
            readers.writeNfc(url, req.optBoolean("onlyIfBlank", true), timeoutOf(req, NFC_TIMEOUT_MS))
        }
    }

    /** Corta la espera de la ficha (el camarero pulsa Cancelar). */
    @JavascriptInterface
    fun cancelRead(json: String) = run(json) {
        readers.cancel()
        JSONObject().put("ok", true)
    }

    /** Con sesión iniciada: pantalla completa y sin Inicio ni Recientes hasta «Salir» (app 0.4+). */
    @JavascriptInterface
    fun lockApp(json: String) = run(json) {
        setLocked(true)
        JSONObject().put("ok", true)
    }

    @JavascriptInterface
    fun unlockApp(json: String) = run(json) {
        setLocked(false)
        JSONObject().put("ok", true)
    }

    /** Al cerrar la app: no se responde a una página que ya no existe. */
    fun shutdown() {
        closed = true
        executor.shutdownNow()
    }

    private fun runExclusive(json: String, op: (JSONObject) -> JSONObject) {
        if (!busy.compareAndSet(false, true)) {
            reply(requestIdOf(json), failure("deviceIsBusy", "El datáfono ya está con otra operación"))
            return
        }
        run(json, onDone = { busy.set(false) }, op = op)
    }

    private fun run(json: String, onDone: () -> Unit = {}, op: (JSONObject) -> JSONObject) {
        val request = try {
            JSONObject(json)
        } catch (e: JSONException) {
            onDone()
            reply(requestIdOf(json), failure("badRequest", "Petición mal formada"))
            return
        }
        val requestId = request.optString("requestId")
        if (!trusted) {
            onDone()
            reply(requestId, failure("untrusted", "Página no autorizada"))
            return
        }
        try {
            executor.execute {
                val response = try {
                    op(request)
                } catch (e: PaytefException) {
                    failure(e.code, e.message ?: "Error del lector")
                } catch (e: JSONException) {
                    failure("badRequest", "Faltan datos de la operación")
                } catch (e: InterruptedException) {
                    failure("cancelled", "Operación interrumpida")
                } catch (e: Exception) {
                    failure("deviceError", "Error del lector")
                } finally {
                    onDone()
                }
                reply(requestId, response)
            }
        } catch (e: Exception) {
            onDone()
            reply(requestId, failure("deviceError", "La app se está cerrando"))
        }
    }

    /** …/?ficha=<código> del mismo dominio que la pantalla del datáfono (BuildConfig.PAX_URL). */
    private fun isFichaUrl(url: String): Boolean {
        if (url.length > MAX_FICHA_URL) return false
        val pax = Uri.parse(BuildConfig.PAX_URL)
        val prefix = pax.scheme + "://" + pax.encodedAuthority + "/?ficha="
        val token = url.removePrefix(prefix)
        return url.startsWith(prefix) && FICHA_TOKEN.matches(token)
    }

    /** El plazo que pide la web, dentro de unos límites (la web espera algo más: 130 s). */
    private fun timeoutOf(req: JSONObject, fallback: Long): Long =
        req.optLong("timeoutMs", fallback).coerceIn(MIN_READ_MS, MAX_READ_MS)

    private fun failure(code: String, message: String): JSONObject =
        JSONObject().put("ok", false).put("error", code).put("message", message)

    /** El requestId aunque el JSON venga roto, para que la web no se quede esperando. */
    private fun requestIdOf(json: String): String =
        REQUEST_ID.find(json)?.groupValues?.get(1) ?: ""

    private fun reply(requestId: String, response: JSONObject) {
        if (closed || requestId.isEmpty()) return
        val script = "window.nightpayPaxCallback && window.nightpayPaxCallback(" +
            JSONObject.quote(requestId) + ", " + JSONObject.quote(response.toString()) + ")"
        main.post { if (!closed) webView.evaluateJavascript(script, null) }
    }

    companion object {
        private const val SCAN_TIMEOUT_MS = 90_000L
        private const val NFC_TIMEOUT_MS = 60_000L
        private const val MIN_READ_MS = 5_000L
        private const val MAX_READ_MS = 90_000L
        private val REQUEST_ID = Regex("\"requestId\"\\s*:\\s*\"([^\"]{1,64})\"")
        /** El código de la ficha: 16–64 caracteres base64url (como isWalletCardToken). */
        private val FICHA_TOKEN = Regex("[A-Za-z0-9_-]{16,64}")
        private const val MAX_FICHA_URL = 200
    }
}
