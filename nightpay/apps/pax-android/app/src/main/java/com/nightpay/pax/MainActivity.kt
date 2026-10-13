package com.nightpay.pax

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.text.InputType
import android.view.WindowManager
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText

/**
 * App NightPay del datáfono PAX: abre la pantalla /pax de NightPay y le da
 * acceso al lector a través de PaxBridge. Nada más: toda la lógica está en
 * la web y en la API, así se actualiza sin reinstalar la app.
 */
class MainActivity : Activity() {

    private lateinit var webView: WebView
    private lateinit var paytef: PaytefClient
    private lateinit var bridge: PaxBridge
    private var settingsDialog: AlertDialog? = null
    private var backPresses = 0
    private var lastBackPress = 0L

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        paytef = PaytefClient(BuildConfig.PAYTEF_URL, prefs.getString(KEY_API_KEY, null))

        webView = WebView(this)
        setContentView(webView)
        // Depuración de la WebView solo si se compila a propósito para ello.
        WebView.setWebContentsDebuggingEnabled(BuildConfig.ALLOW_WEB_DEBUG)
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.settings.allowFileAccess = false
        webView.settings.allowContentAccess = false

        bridge = PaxBridge(webView, paytef)
        webView.webViewClient = object : WebViewClient() {
            // Solo la web de NightPay por HTTPS: cualquier otro enlace se ignora.
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                !isOurPage(request.url)

            // Android 5.1–6 (API < 24) solo llama a esta versión.
            @Deprecated("Necesaria en API < 24")
            override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean =
                !isOurPage(Uri.parse(url))

            // El lector solo atiende a la página de NightPay ya cargada.
            override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
                bridge.trusted = false
                super.onPageStarted(view, url, favicon)
            }

            override fun onPageFinished(view: WebView, url: String) {
                bridge.trusted = isOurPage(Uri.parse(url))
                super.onPageFinished(view, url)
            }
        }
        webView.addJavascriptInterface(bridge, "NightPayPax")
        webView.loadUrl(BuildConfig.PAX_URL)

        if (!prefs.getBoolean(KEY_CONFIGURED, false)) showSettings()
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
    }

    override fun onPause() {
        webView.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        settingsDialog?.dismiss()
        bridge.shutdown()
        webView.removeJavascriptInterface("NightPayPax")
        webView.destroy()
        super.onDestroy()
    }

    /** Cinco veces "atrás" seguidas abre los ajustes (clave de Paytef). */
    @Deprecated("Activity sin AndroidX: onBackPressed sigue funcionando")
    override fun onBackPressed() {
        val now = System.currentTimeMillis()
        backPresses = if (now - lastBackPress < 1500) backPresses + 1 else 1
        lastBackPress = now
        if (backPresses >= 5) {
            backPresses = 0
            showSettings()
            return
        }
        if (webView.canGoBack()) webView.goBack()
    }

    private fun isOurPage(uri: Uri): Boolean {
        val ours = Uri.parse(BuildConfig.PAX_URL)
        return uri.scheme == "https" && uri.host == ours.host
    }

    private fun showSettings() {
        val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        val input = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            setText(prefs.getString(KEY_API_KEY, "") ?: "")
        }
        settingsDialog?.dismiss()
        settingsDialog = AlertDialog.Builder(this)
            .setTitle(R.string.settings_title)
            .setMessage(R.string.settings_message)
            .setView(input)
            .setPositiveButton(R.string.settings_save) { _, _ ->
                val key = input.text.toString().trim()
                prefs.edit().putString(KEY_API_KEY, key).putBoolean(KEY_CONFIGURED, true).apply()
                paytef.apiKey = key
            }
            .setNegativeButton(R.string.settings_skip) { _, _ ->
                prefs.edit().putBoolean(KEY_CONFIGURED, true).apply()
            }
            .show()
    }

    companion object {
        private const val PREFS = "nightpay"
        private const val KEY_API_KEY = "paytefApiKey"
        private const val KEY_CONFIGURED = "configured"
    }
}
