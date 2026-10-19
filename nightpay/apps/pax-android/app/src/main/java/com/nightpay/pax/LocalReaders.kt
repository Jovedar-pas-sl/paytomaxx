package com.nightpay.pax

import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.nfc.FormatException
import android.nfc.NdefMessage
import android.nfc.NdefRecord
import android.nfc.NfcAdapter
import android.nfc.Tag
import android.nfc.tech.Ndef
import android.nfc.tech.NdefFormatable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Lectores del propio datáfono para cobrar del saldo: la cámara (el QR del
 * cobro de la chica o el del cliente, en ScanActivity) y el NFC de Android
 * (fichas NTAG213/215/216 con el enlace …/?ficha=<código> grabado). En la
 * recepción y en «Preparar fichas», además, graba ese enlace en una ficha en
 * blanco (writeNfc): nunca encima de una que ya tiene algo.
 *
 * Llamadas bloqueantes: se usan desde un hilo de fondo (PaxBridge). Mismo
 * contrato de respuesta que el resto del puente:
 * { ok: true, … } | { ok: false, error, message }.
 *
 * El A920 Pro puede tener el lector sin contacto reservado para las tarjetas
 * (lo maneja el módulo PICC de PAX, que usa Paytef para EMV): entonces Android
 * no da NfcAdapter y se responde nfcUnavailable; la pantalla ofrece el QR del
 * cliente o su código.
 * TODO(PAX/Paytef): si no hay NfcAdapter, leer las fichas con la API PICC del
 * SDK de PAX (detectar la tarjeta Mifare Ultralight/NTAG, leer su UID y las
 * páginas NDEF). Hace falta que PAX/Paytef nos den el SDK, su licencia y el
 * permiso en PAXSTORE, y saber si conviven con la app de Paytef. No se inventa
 * aquí ninguna llamada: ver docs/DATAFONO-SALDO.md.
 */
class LocalReaders(private val activity: Activity) {

    private val main = Handler(Looper.getMainLooper())

    /**
     * Una espera de ficha. La cierra quien llega primero: la ficha, cancel()
     * (o onPause) o el plazo. La ficha se queda con ella justo antes de grabar:
     * así nunca se graba después de un «cancelado» o un «timeout» que la web
     * ya ha recibido (dejaría el mismo código en dos fichas).
     */
    private class TagWait {
        val result = ArrayBlockingQueue<JSONObject>(1)
        private val open = AtomicBoolean(true)

        /** true solo para el primero que la cierra. */
        fun claim(): Boolean = open.compareAndSet(true, false)

        /** La respuesta, si nadie la cerró antes (si no, null: se descarta). */
        fun answer(json: JSONObject): JSONObject? = if (claim()) json else null
    }

    @Volatile
    private var pendingNfc: TagWait? = null

    @Volatile
    private var pendingScan: ArrayBlockingQueue<JSONObject>? = null

    /** Qué hacer con la ficha que se acerque: leerla o grabarla (lo fija readNfc / writeNfc). */
    @Volatile
    private var onTag: ((Tag, TagWait) -> JSONObject?)? = null

    /** En un hilo del sistema: leer o grabar la ficha aquí (es E/S) es lo previsto. */
    private val nfcCallback = NfcAdapter.ReaderCallback { tag ->
        val wait = pendingNfc
        val handler = onTag
        if (wait != null && handler != null) {
            val answer = handler(tag, wait)
            if (answer != null) wait.result.offer(answer)
        }
    }

    /** Qué hay en este aparato: NFC de Android (listo, apagado o no disponible) y cámara. */
    fun capabilities(): JSONObject {
        val adapter = nfcAdapter()
        val nfc = when {
            adapter == null -> "unavailable"
            !adapter.isEnabled -> "disabled"
            else -> "ready"
        }
        return ok().put("nfc", nfc).put("camera", hasCamera())
    }

    /** Espera una ficha (modo lector de Android) hasta `timeoutMs` o hasta cancel(). */
    fun readNfc(timeoutMs: Long): JSONObject = waitForTag(timeoutMs) { tag, wait -> wait.answer(readTag(tag)) }

    /**
     * Graba `url` (un registro NDEF URI) en la ficha que acerquen. Con
     * `onlyIfBlank`, una ficha que ya tiene algo grabado no se toca:
     * { written: false, url: el enlace que tenía (o null) }.
     */
    fun writeNfc(url: String, onlyIfBlank: Boolean, timeoutMs: Long): JSONObject {
        val message = try {
            NdefMessage(arrayOf(NdefRecord.createUri(url)))
        } catch (e: IllegalArgumentException) {
            return fail("badRequest", "Enlace no válido")
        }
        return waitForTag(timeoutMs) { tag, wait -> writeTag(tag, url, message, onlyIfBlank, wait) }
    }

    /** Modo lector de Android hasta que se acerque una ficha (y `handler` la lea o la grabe). */
    private fun waitForTag(timeoutMs: Long, handler: (Tag, TagWait) -> JSONObject?): JSONObject {
        val adapter = nfcAdapter() ?: return fail("nfcUnavailable", "Este datáfono no deja leer fichas desde la app")
        if (!adapter.isEnabled) return fail("nfcDisabled", "El NFC del datáfono está apagado")
        val wait = TagWait()
        onTag = handler
        pendingNfc = wait
        main.post {
            try {
                val extras = Bundle().apply { putInt(NfcAdapter.EXTRA_READER_PRESENCE_CHECK_DELAY, PRESENCE_CHECK_MS) }
                adapter.enableReaderMode(activity, nfcCallback, NFC_FLAGS, extras)
            } catch (e: Exception) {
                // App en segundo plano, o el NFC en manos del lector de tarjetas.
                wait.answer(fail("nfcUnavailable", "No se ha podido encender el lector de fichas"))?.let { wait.result.offer(it) }
            }
        }
        try {
            val answer = wait.result.poll(timeoutMs, TimeUnit.MILLISECONDS)
            if (answer != null) return answer
            if (wait.claim()) return fail("timeout", "No se ha acercado ninguna ficha")
            // Se cumplió el plazo con una ficha grabándose: su resultado, no un «timeout».
            return wait.result.poll(LATE_RESULT_MS, TimeUnit.MILLISECONDS)
                ?: fail("writeUnknown", "No se sabe si la ficha se grabó: acércala otra vez para comprobarla")
        } finally {
            pendingNfc = null
            onTag = null
            main.post {
                try {
                    adapter.disableReaderMode(activity)
                } catch (e: Exception) {
                    // ya estaba apagado (la app pasó a segundo plano)
                }
            }
        }
    }

    /** Abre la cámara (ScanActivity) y espera el texto del QR hasta `timeoutMs`. */
    fun scanQr(timeoutMs: Long): JSONObject {
        if (!hasCamera()) return fail("noCamera", "Este datáfono no tiene cámara")
        val result = ArrayBlockingQueue<JSONObject>(1)
        pendingScan = result
        main.post {
            try {
                activity.startActivityForResult(Intent(activity, ScanActivity::class.java), REQUEST_SCAN)
            } catch (e: Exception) {
                result.offer(fail("noCamera", "No se ha podido abrir la cámara"))
            }
        }
        try {
            val answer = result.poll(timeoutMs, TimeUnit.MILLISECONDS)
            if (answer != null) return answer
            main.post { activity.finishActivity(REQUEST_SCAN) }
            return fail("timeout", "No se ha leído ningún QR")
        } finally {
            pendingScan = null
        }
    }

    /** Lo que devolvió ScanActivity (desde MainActivity.onActivityResult). */
    fun onScanResult(resultCode: Int, data: Intent?) {
        val queue = pendingScan ?: return
        val text = data?.getStringExtra(ScanActivity.EXTRA_TEXT)
        val answer = if (resultCode == Activity.RESULT_OK && !text.isNullOrEmpty()) {
            ok().put("text", text)
        } else {
            fail(
                data?.getStringExtra(ScanActivity.EXTRA_ERROR) ?: "cancelled",
                data?.getStringExtra(ScanActivity.EXTRA_MESSAGE) ?: "Cancelado",
            )
        }
        queue.offer(answer)
    }

    /**
     * El camarero cancela en la pantalla: la espera de la ficha termina ya.
     * Si la ficha ya se está grabando, gana su resultado (no se dice «cancelado»).
     */
    fun cancel() {
        val wait = pendingNfc ?: return
        wait.answer(fail("cancelled", "Cancelado"))?.let { wait.result.offer(it) }
    }

    /** La app pasa a segundo plano: Android apaga el modo lector; quien esperaba se entera. */
    fun onPause() = cancel()

    fun shutdown() {
        cancel()
        pendingScan?.offer(fail("cancelled", "La app se está cerrando"))
    }

    private fun hasCamera(): Boolean =
        activity.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)

    private fun nfcAdapter(): NfcAdapter? =
        try {
            NfcAdapter.getDefaultAdapter(activity)
        } catch (e: Exception) {
            null
        }

    /** Número de serie (hex, como lo normaliza el API) y el enlace NDEF grabado. */
    private fun readTag(tag: Tag): JSONObject {
        val url = try {
            ndefUrl(tag)
        } catch (e: Exception) {
            null
        }
        return ok().put("uid", uidOf(tag) ?: JSONObject.NULL).put("url", url ?: JSONObject.NULL)
    }

    private fun uidOf(tag: Tag): String? = tag.id?.joinToString("") { String.format("%02X", it) }

    /**
     * Graba el enlace. Una ficha NDEF que ya tiene algo (con onlyIfBlank) no se
     * toca, tampoco una cuyo contenido no se entiende (NDEF corrupto: puede ser
     * otra cosa); una sin formatear (NdefFormatable) se formatea con el enlace.
     * Justo antes de grabar se queda con la espera: si ya la cerraron
     * (cancelado, plazo), no graba y devuelve null.
     */
    private fun writeTag(tag: Tag, url: String, message: NdefMessage, onlyIfBlank: Boolean, wait: TagWait): JSONObject? {
        val uid: Any = uidOf(tag) ?: JSONObject.NULL
        val ndef = Ndef.get(tag)
        if (ndef == null) return formatTag(tag, url, message, uid, wait)
        try {
            ndef.connect()
            val current: NdefMessage? = try {
                ndef.ndefMessage
            } catch (e: FormatException) {
                // No se entiende lo grabado: «otra cosa», nunca se graba encima.
                return wait.answer(ok().put("uid", uid).put("url", JSONObject.NULL).put("written", false))
            }
            if (onlyIfBlank && !isBlank(current)) {
                return wait.answer(ok().put("uid", uid).put("url", firstUri(current) ?: JSONObject.NULL).put("written", false))
            }
            if (!ndef.isWritable) return wait.answer(fail("readOnly", "La ficha está protegida contra escritura"))
            if (message.toByteArray().size > ndef.maxSize) return wait.answer(fail("tooSmall", "En esta ficha no cabe el enlace"))
            if (!wait.claim()) return null
            ndef.writeNdefMessage(message)
            return ok().put("uid", uid).put("url", url).put("written", true)
        } catch (e: IOException) {
            return answerAfterClaim(wait, fail("writeFailed", "No se ha podido grabar la ficha"))
        } catch (e: FormatException) {
            return answerAfterClaim(wait, fail("writeFailed", "No se ha podido grabar la ficha"))
        } finally {
            try {
                ndef.close()
            } catch (e: IOException) {
                // ficha ya retirada
            }
        }
    }

    /** Ficha sin formatear (de fábrica): se formatea NDEF con el enlace. Está en blanco por definición. */
    private fun formatTag(tag: Tag, url: String, message: NdefMessage, uid: Any, wait: TagWait): JSONObject? {
        val formatable = NdefFormatable.get(tag)
            ?: return wait.answer(fail("writeFailed", "Esta ficha no admite el enlace: usa una NTAG213/215/216"))
        try {
            formatable.connect()
            if (!wait.claim()) return null
            formatable.format(message)
            return ok().put("uid", uid).put("url", url).put("written", true)
        } catch (e: IOException) {
            return answerAfterClaim(wait, fail("writeFailed", "No se ha podido grabar la ficha"))
        } catch (e: FormatException) {
            return answerAfterClaim(wait, fail("writeFailed", "No se ha podido grabar la ficha"))
        } finally {
            try {
                formatable.close()
            } catch (e: IOException) {
                // ficha ya retirada
            }
        }
    }

    /**
     * Un fallo de E/S: si fue al conectar (antes de quedarse con la espera) se
     * responde si nadie la cerró; si fue grabando, ya es suya y se responde.
     */
    private fun answerAfterClaim(wait: TagWait, json: JSONObject): JSONObject = wait.answer(json) ?: json

    /** Sin mensaje, sin registros o solo registros vacíos: en blanco. */
    private fun isBlank(message: NdefMessage?): Boolean {
        val records = message?.records ?: return true
        return records.all { it.tnf == NdefRecord.TNF_EMPTY }
    }

    private fun firstUri(message: NdefMessage?): String? {
        val records = message?.records ?: return null
        for (record in records) {
            val uri = record.toUri() ?: continue
            return uri.toString()
        }
        return null
    }

    private fun ndefUrl(tag: Tag): String? {
        val ndef = Ndef.get(tag) ?: return null
        val message = ndef.cachedNdefMessage ?: try {
            ndef.connect()
            ndef.ndefMessage
        } finally {
            try {
                ndef.close()
            } catch (e: IOException) {
                // ficha ya retirada
            }
        }
        val records = message?.records ?: return null
        for (record in records) {
            val uri = record.toUri() ?: continue
            return uri.toString()
        }
        return null
    }

    companion object {
        const val REQUEST_SCAN = 1501
        private const val NFC_FLAGS = NfcAdapter.FLAG_READER_NFC_A
        private const val PRESENCE_CHECK_MS = 250

        /** Plazo cumplido con una ficha grabándose: lo que se espera aún a su resultado. */
        private const val LATE_RESULT_MS = 10_000L

        private fun ok(): JSONObject = JSONObject().put("ok", true)

        private fun fail(code: String, message: String): JSONObject =
            JSONObject().put("ok", false).put("error", code).put("message", message)
    }
}
