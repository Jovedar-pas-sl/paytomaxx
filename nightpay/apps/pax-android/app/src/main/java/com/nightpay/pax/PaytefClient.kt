package com.nightpay.pax

import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.Proxy
import java.net.URL

/** Error de la Device API con su código (deviceIsBusy, serviceIsDown, timeout…). */
class PaytefException(val code: String, message: String) : Exception(message)

/**
 * Cliente de la Device API de Paytef en el propio datáfono
 * (https://docs.paytef.es/device_api/). Llamadas bloqueantes: se usan desde
 * un hilo de fondo.
 *
 * Pendiente de confirmar con Paytef y un terminal de pruebas: el formato
 * exacto de los errores y de la lista de operaciones del cierre.
 */
class PaytefClient(private val baseUrl: String, @Volatile var apiKey: String?) {

    /** Venta: manda el importe al lector y espera al cliente. */
    fun sale(amountCents: Int, reference: String): JSONObject {
        post(
            "/transaction/start",
            JSONObject()
                .put("pinpad", "*")
                .put("opType", "sale")
                .put("requestedAmount", amountCents)
                .put("transactionReference", reference)
                .put("language", "es")
                .put("executeOptions", JSONObject().put("method", "polling")),
        )
        return ok(waitForResult(reference))
    }

    /** Anula una venta ya hecha (doble cobro o importe equivocado). */
    fun void(operationNumber: String, amountCents: Int, reference: String): JSONObject {
        post(
            "/transaction/start",
            JSONObject()
                .put("pinpad", "*")
                .put("opType", "cancel")
                .put("requestedAmount", amountCents)
                .put("transactionReference", reference)
                .put("language", "es")
                .put("operationDetails", JSONObject().put("previousOperationNumber", operationNumber))
                .put("executeOptions", JSONObject().put("method", "polling")),
        )
        return ok(waitForResult(reference))
    }

    /** Corta la venta en curso (el cliente se arrepiente). */
    fun cancel(): JSONObject {
        post("/pinpad/cancel", JSONObject().put("pinpad", "*"))
        return JSONObject().put("ok", true)
    }

    /** Última operación del lector: para recuperar un resultado perdido. */
    fun lastResult(): JSONObject {
        val response = post("/pinpad/getLastResult", JSONObject().put("pinpad", "*"))
        val result = response.optJSONObject("result")
            ?: throw PaytefException("noResult", "No hay ninguna operación reciente en el datáfono")
        return ok(result)
    }

    /** Operaciones de la jornada del datáfono (sin cerrarla), para cuadrar. */
    fun shiftList(): JSONObject {
        val response = post(
            "/pinpad/manageWorkShift",
            JSONObject()
                .put("pinpad", "*")
                .put("returnTransactionList", true)
                .put("closeShift", false)
                .put("listType", "terminal"),
        )
        val list = response.optJSONArray("transactions")
            ?: response.optJSONObject("result")?.optJSONArray("transactions")
            ?: JSONArray()
        return JSONObject().put("ok", true).put("transactions", list)
    }

    /**
     * Espera al resultado de la operación que acabamos de lanzar. Un fallo
     * suelto al consultar no la da por perdida (el cliente puede estar pagando):
     * se sigue preguntando hasta el límite. Al rendirse, se cancela en el lector.
     */
    private fun waitForResult(reference: String): JSONObject {
        val deadline = System.currentTimeMillis() + SALE_TIMEOUT_MS
        var failures = 0
        while (System.currentTimeMillis() < deadline) {
            Thread.sleep(POLL_EVERY_MS)
            val response = try {
                post("/transaction/poll", JSONObject().put("pinpad", "*")).also { failures = 0 }
            } catch (e: PaytefException) {
                if (e.code != "serviceIsDown" && e.code != "httpError") throw e
                failures += 1
                if (failures >= MAX_POLL_FAILURES) throw e
                continue
            }
            val status = response.optJSONObject("info")?.optString("transactionStatus")
            val result = response.optJSONObject("result")
            if (status != "finished" || result == null) continue
            // Un resultado de otra operación (la anterior) no vale.
            val ref = result.optString("transactionReference")
            if (ref.isNotEmpty() && ref != reference) continue
            return result
        }
        try {
            cancel()
        } catch (e: PaytefException) {
            // el lector puede no responder: el aviso de abajo basta
        }
        throw PaytefException("timeout", "El lector no responde")
    }

    private fun ok(result: JSONObject): JSONObject = JSONObject().put("ok", true).put("result", result)

    private fun post(path: String, body: JSONObject): JSONObject {
        val conn = URL(baseUrl + path).openConnection(Proxy.NO_PROXY) as HttpURLConnection
        try {
            conn.requestMethod = "POST"
            conn.connectTimeout = CONNECT_TIMEOUT_MS
            conn.readTimeout = READ_TIMEOUT_MS
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json")
            apiKey?.takeIf { it.isNotBlank() }?.let { conn.setRequestProperty("X-Api-Key", it) }
            conn.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }

            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.bufferedReader()?.use { it.readText() } ?: ""
            val json = try {
                JSONObject(text)
            } catch (e: Exception) {
                JSONObject()
            }
            val error = json.optJSONObject("error")
            if (code !in 200..299 || error != null) {
                val errCode = error?.optString("code")?.takeIf { it.isNotBlank() } ?: "httpError"
                val errMessage = error?.optString("message")?.takeIf { it.isNotBlank() } ?: "Error del datáfono ($code)"
                throw PaytefException(errCode, errMessage)
            }
            return json
        } catch (e: PaytefException) {
            throw e
        } catch (e: Exception) {
            throw PaytefException("serviceIsDown", "No se puede hablar con el lector: ${e.javaClass.simpleName}")
        } finally {
            conn.disconnect()
        }
    }

    companion object {
        /** Menos que la web (200 s): así la web siempre recibe la respuesta. */
        private const val SALE_TIMEOUT_MS = 170_000L
        private const val POLL_EVERY_MS = 700L
        private const val MAX_POLL_FAILURES = 5
        private const val CONNECT_TIMEOUT_MS = 5_000
        private const val READ_TIMEOUT_MS = 30_000
    }
}
